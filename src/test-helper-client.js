const { SQSClient, CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand } = require("@aws-sdk/client-sqs");
const { EventBridgeClient, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand, DeleteRuleCommand, PutEventsCommand, DescribeRuleCommand } = require("@aws-sdk/client-eventbridge");
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");
const { fromEnv } = require("@aws-sdk/credential-providers");

// #region Create aws clients
const config = {
  credentials: fromEnv(),
};
const sqs = new SQSClient(config);
const eventBridge = new EventBridgeClient(config);
const sts = new STSClient(config);
// #endregion

/**
 * Create a client to hold the testing configuration
 * This client spins up fairly rapidly so it can be span up and down if the context of the test changes
 *
 * @param {object} args Client configurations
 * @param {string} args.serviceName The name of the service used to generate the testing architecture
 * @param {string} args.serviceSource The source we look for in resultant events. Used to tag the architecture and build the event pattern
 * @param {string} args.busName The name of the event bridge bus
 * @param {string} args.region The region of the event bridge bus
 *
 * @returns {object} The client with appropriate functions to interact with the testing architecture
 */
const TestNVacClient = ({ serviceName, serviceSource, busName, region }) => {
  /**
   * @type {string} The URL of the Amazon SQS queue from which messages are received. Queue URLs and names are case-sensitive.
   */
  let sqsQueueUrl;
  const randomString = Math.random().toString(36).substring(2, 15);
  const sqsQueueName = serviceName + "-tests-queue-" + randomString;
  const eventBridgeRuleName = serviceName + "-tests-rule-" + randomString;
  const eventBridgeTargetId = serviceName + "-tests-target-" + randomString;
  /**
   * @type {Record<string, string>} Amazon SQS cost allocation tags
   */
  const tags = {
    serviceSource,
    'test-n-vac': serviceSource
  };

  return {
    /**
     * Creates the aws architecture used for testing events
     * @async
     */
    createTestArchitecture: async () => {
      /**
       * The Amazon Web Services ARN associated with the calling entity.
       * @const {string}
       */
      const accountId = await sts.send(new GetCallerIdentityCommand())
        .then(data => data.Account)
        .catch(err => {
          console.error("Error in createTestArchitecture while getting accountId: ", err);
          throw err;
        });

      // Create a temporary AWS SQS queue
      /**
       * @type {CreateQueueCommandInput}
       */
      const params = {
        QueueName: sqsQueueName,
        Attributes: {
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowSQS",
                Effect: "Allow",
                Principal: {
                  Service: "events.amazonaws.com"
                },
                Action: "SQS:SendMessage",
                Resource: `arn:aws:sqs:${region}:${accountId}:${sqsQueueName}`
              }
            ]
          }),
        },
        tags
      };

      console.info("Creating testing queue: " + sqsQueueName);
      sqsQueueUrl = await sqs.send(new CreateQueueCommand(params))
        .then(data => data.QueueUrl)
        .catch(err => {
          console.error("Error in createTestArchitecture while creating testing queue: ", err);
        });

      // Wait for 1 second based on second note here: https://docs.aws.amazon.com/cli/latest/reference/sqs/create-queue.html
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Create an eventBridge rule
      /**
       * @type {PutRuleCommandInput}
       */
      const eventBridgeRule = {
        Name: eventBridgeRuleName,
        EventPattern: `{
          "source": [
            "${serviceSource}"
          ]
        }`,
        EventBusName: busName,
        tags
      };

      console.info("Creating testing rule: " + eventBridgeRuleName);
      await eventBridge.send(new PutRuleCommand(eventBridgeRule))
        .catch(err => {
          console.error("Error in createTestArchitecture while creating testing rule: ", err);
        });

      // Create an eventBridge target
      /**
       * @type {PutTargetsCommandInput}
       */
      const eventBridgeTarget = {
        Rule: eventBridgeRuleName,
        EventBusName: busName,
        Targets: [
          {
            Id: eventBridgeTargetId,
            Arn: `arn:aws:sqs:${region}:${accountId}:${sqsQueueName}`
          }
        ]
      };

      console.info("Creating testing target: " + eventBridgeTargetId);
      await eventBridge.send(new PutTargetsCommand(eventBridgeTarget))
        .catch(err => {
          console.error("Error in createTestArchitecture while creating testing target: ", err);
        });

      await new Promise(resolve => setTimeout(resolve, 60000));
    },

    /**
     * Tears down the aws architecture used for testing events
     * @async
     */
    destroyTestArchitecture: async () => {
      // Delete the EventBridge target
      console.info("Destroying testing target: " + eventBridgeTargetId);
      await eventBridge.send(new RemoveTargetsCommand({ Ids: [eventBridgeTargetId], Rule: eventBridgeRuleName, EventBusName: busName }))
        .catch(err => {
          console.error("Error in destroyTestArchitecture while destroying testing target: ", err);
        });

      // Delete the EventBridge rule
      console.info("Destroying testing rule: " + eventBridgeRuleName);
      await eventBridge.send(new DeleteRuleCommand({ EventBusName: busName, Name: eventBridgeRuleName }))
        .catch(err => {
          console.error("Error in destroyTestArchitecture while destroying testing rule: ", err);
        });

      // Remove the SQS queue
      console.info("Destroying testing queue: " + sqsQueueName);
      await sqs.send(new DeleteQueueCommand({
        QueueUrl: sqsQueueUrl
      }))
        .catch(err => {
          console.error("Error in destroyTestArchitecture while destroying testing queue: ", err);
        });
    },

    /**
     * A function that gets messages from sqs and returns them as an array.
     * @async
     */
    getMessagesFromSQS: async () => {

      const checkSQSQueue = async () => {
        /**
         * @type {ReceiveMessageCommandInput}
         */
        const params = {
          QueueUrl: sqsQueueUrl,
          WaitTimeSeconds: 20
        };

        return sqs.send(new ReceiveMessageCommand(params))
          .then(data => data.Messages)
          .catch(err => {
            console.error("Error in getMessagesFromSQS while checking SQS queue: ", err);
          });
      };

      let outputEvents = await checkSQSQueue();

      for (let i = 1; i < 5; i++) {
        if (!outputEvents || outputEvents.length === 0) {
          console.log('No events found in SQS queue. Trying again in 20 seconds... Attempt: ' + i);
          outputEvents = await checkSQSQueue();
        }
        else {
          break;
        }
      }

      if (!outputEvents || outputEvents.length === 0) {
        throw new Error('No events found in SQS queue');
      }

      return outputEvents.map(event => JSON.parse(event.Body));
    },
    /**
     * Fire an event to the eventBridge
     *
     * @async
     * @param {string} event The entry to fire as the event, no need to include the event bus name as we generate it at the top of this file
     * @param {string} detailType The detail type of the event
    */
    fireEvent: async (event, detailType) => {
      const params = {
        Entries: [
          {
            Detail: JSON.stringify(event),
            DetailType: detailType,
            EventBusName: busName,
            Source: serviceSource
          }
        ]
      };
      return eventBridge.send(new PutEventsCommand(params))
        .catch(err => {
          console.error("Error in fireEvent while firing event: ", err);
        });
    }
  };
};

module.exports = { TestNVacClient };

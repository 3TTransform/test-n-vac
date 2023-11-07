const { SQSClient, CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, PurgeQueueCommand } = require("@aws-sdk/client-sqs");
const { EventBridgeClient, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand, DeleteRuleCommand, PutEventsCommand } = require("@aws-sdk/client-eventbridge");
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
 * @param {array} [args.detailTypes=[]] The list of detail types that the tested service uses
 *
 * @returns {object} The client with appropriate functions to interact with the testing architecture
 */
const TestNVacClient = ({ serviceName, serviceSource, busName, region, detailTypes = [] }) => {
  /**
   * @type {string} The URL of the Amazon SQS queue from which messages are received. Queue URLs and names are case-sensitive.
   */
  let sqsQueueUrl;
  const randomString = Math.random().toString(36).substring(2, 15);
  const sqsQueueName = serviceName + "-tests-queue-" + randomString;
  const eventBridgeRuleName = serviceName + "-tests-rule-" + randomString;
  const eventBridgeTargetId = serviceName + "-tests-target-" + randomString;
  const testEventDetailType = `Test Event ${randomString}`;
  /**
   * @type {Record<string, string>} Amazon SQS cost allocation tags
   */
  const tags = {
    serviceSource,
    'test-n-vac': serviceSource
  };

  /**
   * A function that gets messages from sqs and returns them as an array.
   * @async
   * @param {number} [waitTimeSeconds=20] The polling interval, ie, the number of seconds to wait to collect sqs messages.
   * @param {number} [attempts=4] The number of attempts to retrieve the messages from sqs
   */
  const getMessagesFromSQS = async (waitTimeSeconds = 20, attempts = 4) => {

    /**
     * A function that gets messages from an SQS queue
     * @async
     * @param {number} [waitTimeSeconds=20] The polling interval, ie, the number of seconds to wait to collect sqs messages.
     */
    const checkSQSQueue = async (waitTimeSeconds) => {
      /**
       * @type {ReceiveMessageCommandInput}
       */
      const params = {
        QueueUrl: sqsQueueUrl,
        WaitTimeSeconds: waitTimeSeconds
      };

      return (await sqs.send(new ReceiveMessageCommand(params))).Messages;
    };

    let outputEvents = await checkSQSQueue(waitTimeSeconds);
    for (let i = 1; i < attempts + 1; i++) {
      if (!outputEvents || outputEvents.length === 0) {
        const tryAgainMsg = (i < attempts) ? `Trying again in ${waitTimeSeconds} seconds... Attempt: ${i}` : '';
        console.info(`\tNo events found in SQS queue. ${tryAgainMsg}`);
        outputEvents = await checkSQSQueue(waitTimeSeconds);
      }
      else {
        break;
      }
    }

    if (!outputEvents || outputEvents.length === 0) {
      throw new Error(`No events found in SQS queue after ${attempts} attempt(s)`);
    }

    return outputEvents.map(event => JSON.parse(event.Body));
  };

  /**
   * Fire an event to the eventBridge
   * @async
   * @param {string} event The entry to fire as the event, no need to include the event bus name as we generate it at the top of this file
   * @param {string} detailType The detail type of the event
  */
  const fireEvent = async (event, detailType) => {
    try {

      /**
       * @type {PutEventsCommand}
       */
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

      return eventBridge.send(new PutEventsCommand(params));

    } catch (err) {
      console.error(`Error in fireEvent while firing event: ${err.message}`, err);
      // fail the test run if event cannot be raised
      throw err;
    };
  };

  /**
   * Waits for Event Bridge Rule to be ready
   * @async
   * @param {number} timeout The maximum time to wait before returning rule not available
  */
  const waitForRule = async (timeout = 60) => {
    /**
     * Checks if Event Bridge Rule is ready to use, by firing events to it and looking for them in the SQS queue.
     * @async
    */
    const checkRuleReady = async () => {
      try {
        await fireEvent({}, testEventDetailType);
        // only retry once as we keep firing events
        const numberOfMessages = (await getMessagesFromSQS(2, 1)).length || 0;
        return numberOfMessages > 0;
      } catch (err) {
        // Rule is not ready, try again later
        return false;
      }
    };

    console.info('\n > Checking EB rule');
    const startTime = Date.now();
    while ((Date.now() - startTime) / 1000 < timeout) {
      if (await checkRuleReady()) {
        console.info('\tEB Rule ready!');
        return;
      }
    }

    // fail the test run if the SQS queue is not ready
    throw new Error(`Rule ${ruleName} did not become ready within ${timeout} seconds`);
  };

  /**
   * Purges an SQS queue
   * @async
   * @param {string} queueUrl The URL of the AWS SQS queue
   */
  const purgeQueue = async (queueUrl) => {
    try {
      /**
       * @type {PurgeQueueCommandInput}
       */
      const params = {
        QueueUrl: queueUrl
      };

      console.info(`\n > Purging testing queue: ${queueUrl}`);
      await sqs.send(new PurgeQueueCommand(params));
      // Wait after command issued before sending new events
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.info(`\tSQS queue purged!`);

    } catch (err) {
      console.error(`Error while purging testing queue: ${err.message}`, err);
      // fail the test run, as there are issues with the SQS queue
      throw err;
    }
  };

  /**
   * Creates the aws architecture used for testing events
   * @async
   */
  const createTestArchitecture = async () => {
    try {
      console.info("\n > Creating AWS Resources");
      /**
       * The Amazon Web Services ARN associated with the calling entity.
       * @const {string}
       */
      const accountId = (await sts.send(new GetCallerIdentityCommand())).Account;

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

      console.info(`\tCreating testing queue: ${sqsQueueName}`);
      sqsQueueUrl = (await sqs.send(new CreateQueueCommand(params))).QueueUrl;

      // Create an eventBridge rule
      const eventDetailType = (detailTypes.length > 0) ?
        `, "detail-type": ["${testEventDetailType}","${detailTypes.join("\",\"")}"]`
        : ""

      /**
       * @type {PutRuleCommandInput}
       */
      const eventBridgeRule = {
        Name: eventBridgeRuleName,
        EventPattern: `{
            "source": [
              "${serviceSource}"
            ]
            ${eventDetailType}
          }`,
        EventBusName: busName,
        tags
      };

      console.info(`\tCreating testing rule: ${eventBridgeRuleName}`);
      await eventBridge.send(new PutRuleCommand(eventBridgeRule));

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

      console.info(`\tCreating testing target: ${eventBridgeTargetId}`);
      await eventBridge.send(new PutTargetsCommand(eventBridgeTarget));

      // EB rules can take around 60 seconds to be ready to use
      await waitForRule();

      // Queue should be empty before running tests.
      await purgeQueue(sqsQueueUrl);

      console.info("\n > Running tests");
    } catch (err) {
      console.error(`Error in createTestArchitecture: ${err.message}`, err);
      throw err;
    }
  };

  /**
   * Tears down the aws architecture used for testing events
   * @async
   */
  const destroyTestArchitecture = async () => {
    try {
      console.info("\n > Destroying AWS Resources");
      // Delete the EventBridge target
      console.info(`\tDestroying testing target: ${eventBridgeTargetId}`);
      await eventBridge.send(new RemoveTargetsCommand({ Ids: [eventBridgeTargetId], Rule: eventBridgeRuleName, EventBusName: busName }));

      // Delete the EventBridge rule
      console.info(`\tDestroying testing rule: ${eventBridgeRuleName}`);
      await eventBridge.send(new DeleteRuleCommand({ EventBusName: busName, Name: eventBridgeRuleName }));

      // Remove the SQS queue
      console.info(`\tDestroying testing queue: ${sqsQueueName}`);
      await sqs.send(new DeleteQueueCommand({
        QueueUrl: sqsQueueUrl
      }));

    } catch (err) {
      console.error(`Error in destroyTestArchitecture: ${err.message}`, err);
      // Notify user that they must destroy these AWS resources manually
      console.info("!!!IMPORTANT!!!: please ensure the following AWS resources have been removed:\n"
        + `Event Bridge Rule Target: ${eventBridgeTargetId}\n`
        + `Event Bridge Rule: ${eventBridgeRuleName}\n`
        + `SQS queue: ${sqsQueueName}`);
      // fail the test run (otherwise people might forget to remove the AWS resources)
      throw err;
    }
  };


  return {
    createTestArchitecture,
    destroyTestArchitecture,
    getMessagesFromSQS,
    fireEvent
  };
};

module.exports = { TestNVacClient };

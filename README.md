<h1 align="center">💨 Test-N-Vac ✅</h1>
<p>
  <img alt="Version" src="https://img.shields.io/badge/version-1.1.3-blue.svg?cacheSeconds=2592000" />
  <a href="#" target="_blank">
    <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" />
  </a>
</p>

> The `Test-N-Vac` is a helper service that can be included in any JavaScript tests. The helper allows the tests to set up an architecture in the cloud that allows us to test our stacks from event in to event out.

### 🏠 [3T Transform Homepage](https://www.3t-transform.com/)

For a tear down on how we have approached integration testing, take a look @ our blog!
https://blog.3tplatform.com/an-exploration-of-integration-testing-in-a-serverless-environment

## Requirements

- AWS Account with the ability to:
  - Put Events
  - Create a SQS Queue
  - Create a Rule
  - Create an Event Target

## Installation

NPM:

```
npm install @3t-transform/test-n-vac
```

Yarn:

```
yarn add @3t-transform/test-n-vac
```

## Usage

The usage examples include the addition of an `env` file, this is a json/javascript file that contains the following:

- The stage that we are testing e.g. `uat`. This is used to construct the event bridge name.
- The region that the service is in that we are testing.

In your tests import the library:

```javascript
const { testNVacClient } = require("@3t-transform/test-n-vac");
```

Create a client passing in the required values:

```javascript
const helperClient = TestNVacClient({
	serviceName: "XXX",
	serviceSource: `integration.testing.${randomString}`,
	busName: `eventbridge-${process.env.Testing.STAGE_NAME}`, // The event bus name that the service is attached to
	region: process.env.AWS_REGION,
});
```

For more information on the client inputs, the code is documented

Before and after your test you need to spin up the testing architecture:

```javascript
before(async () => {
	await helperClient.createTestArchitecture();
});

after(async () => {
	await helperClient.destroyTestArchitecture();
});
```

In the test, construct your event how you expect the rule to fire and call the fire event function:

```javascript
await helperClient.fireEvent(request, "Event Topic");
```

Immediately following firing the event you can then run the following to check for resultant messages:

```javascript
// We must call this one first as there is no way of telling what is the original event vs resultant events as they all match the same source
const initialEvent = await helperClient.getMessagesFromSQS();

const resultantEvent = await helperClient.getMessagesFromSQS();
```

If you have multiple events you can call this multiple times.

It's possible to increase the number of messages received, but that can be funky, it's better to get them one at a time from the queue

## Author

👤 **3t Transform**

## Show your support

Give a ⭐️ if this project helped you!

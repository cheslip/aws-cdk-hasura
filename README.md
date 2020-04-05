# Hasura for AWS CDK

Configures a [Hasura](https://hasura.io/) instance and RDS Postgres database
for [aws-cdk](https://aws.amazon.com/cdk/)

## Installation

```
npm install aws-cdk-hasura
```

or

```
yarn add aws-cdk-hasura
```

## Usage

```typescript
import * as ec2 from "@aws-cdk/aws-ec2";
import { Hasura } from "aws-cdk-hasura";

const vpc = ec2.Vpc.fromLookup(this, "VPC", { isDefault: true });

new Hasura(this, "Hasura", {
  vpc: vpc, // VPC required
});
```

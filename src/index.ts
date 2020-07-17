import { Construct } from "@aws-cdk/core";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecs from "@aws-cdk/aws-ecs";
import * as ecs_patterns from "@aws-cdk/aws-ecs-patterns";
import * as rds from "@aws-cdk/aws-rds";
import * as secrets from "@aws-cdk/aws-secretsmanager";

export interface HasuraServiceProps
  extends ecs_patterns.ApplicationLoadBalancedFargateServiceProps {
  cluster?: ecs.ICluster;
}

export interface HasuraRdsProps
  extends Omit<
    rds.DatabaseInstanceProps,
    "engine" | "vpc" | "masterUsername"
  > {
  masterUsername?: string;
}

export interface HasuraProps {
  vpc: ec2.IVpc;
  rds?: HasuraRdsProps;
  hasuraServiceProps?: HasuraServiceProps;
  hasuraOptions?: {
    version?: string;
    imageName?: string;
    enableTelemetry?: boolean;
    enableConsole?: boolean;
    adminSecret?: secrets.ISecret;
    jwtSecret?: secrets.ISecret;
    env?: {
      [x: string]: string;
    };
    secrets?: {
      [x: string]: ecs.Secret
    };
  };
}

export class Hasura extends Construct {
  public readonly connectionString: string;
  public readonly service: ecs_patterns.ApplicationLoadBalancedFargateService;
  public readonly postgres: rds.DatabaseInstance;
  public readonly passwordSecret?: secrets.Secret;

  constructor(
    scope: Construct,
    id: string,
    public readonly props: HasuraProps
  ) {
    super(scope, id);

    // database name
    let databaseName = props.rds?.databaseName || "postgres";

    // database username
    let username = props.rds?.masterUsername || "hasura";

    // setup password secret
    let passwordSecret = props.rds?.masterUserPassword;
    if (!passwordSecret) {
      this.passwordSecret = this.getHasuraSecret("InstancePassword");
      passwordSecret = this.passwordSecret.secretValue;
    }

    // postgres database instance
    this.postgres = new rds.DatabaseInstance(this, "Instance", {
      engine: rds.DatabaseInstanceEngine.POSTGRES,
      vpc: props.vpc,
      ...props.rds,
      vpcPlacement: props.rds?.vpcPlacement || {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      databaseName: databaseName,
      masterUsername: username,
      masterUserPassword: passwordSecret,
      instanceType:
        props.rds?.instanceType ||
        ec2.InstanceType.of(
          ec2.InstanceClass.BURSTABLE2,
          ec2.InstanceSize.LARGE
        ),
    });

    // postgres connection string
    this.connectionString = `postgres://${username}:${passwordSecret}@${this.postgres.dbInstanceEndpointAddress}:${this.postgres.dbInstanceEndpointPort}/${databaseName}`;

    // ALB / Fargate / Hasura container setup
    this.service = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      "Hasura",
      {
        ...(props.hasuraServiceProps || {}),
        assignPublicIp: props.hasuraServiceProps?.assignPublicIp || true,
        cluster:
          props.hasuraServiceProps?.cluster ||
          new ecs.Cluster(this, "Cluster", {
            vpc: props.vpc,
          }),
        taskImageOptions: {
          image: ecs.ContainerImage.fromRegistry(
            `${props.hasuraOptions?.imageName || "hasura/graphql-engine"}:${props.hasuraOptions?.version || "latest"}`
          ),
          containerPort: 8080,
          environment: this.getEnvironment(),
          secrets: this.getSecrets(),
        },
      }
    );

    // configure health check endpoint for hasura
    this.service.targetGroup.configureHealthCheck({
      path: "/healthz",
    });

    // allow postgres connection from ECS service
    this.postgres.connections.allowFrom(
      this.service.service,
      ec2.Port.tcp(this.postgres.instanceEndpoint.port)
    );
  }

  private getEnvironment(): { [x: string]: string } {
    let environment: { [x: string]: string } = {
      HASURA_GRAPHQL_DATABASE_URL: this.connectionString,
      HASURA_GRAPHQL_ENABLE_TELEMETRY: this.props.hasuraOptions?.enableTelemetry
        ? "true"
        : "false",
      HASURA_GRAPHQL_ENABLE_CONSOLE: this.props.hasuraOptions?.enableConsole
        ? "true"
        : "false",
    };

    if (this.props.hasuraOptions?.env) {
      environment = { ...environment, ...this.props.hasuraOptions.env };
    }

    return environment;
  }

  private getSecrets(): { [x: string]: ecs.Secret } {
    let secrets: { [x: string]: ecs.Secret } = {};

    if (this.props.hasuraOptions?.adminSecret) {
      secrets.HASURA_GRAPHQL_ADMIN_SECRET = ecs.Secret.fromSecretsManager(this.props.hasuraOptions.adminSecret);
    } else {
      secrets.HASURA_GRAPHQL_ADMIN_SECRET = ecs.Secret.fromSecretsManager(
        this.getHasuraSecret("AdminSecret")
      );
    }

    if (this.props.hasuraOptions?.jwtSecret) {
      secrets.HASURA_GRAPHQL_JWT_SECRET = ecs.Secret.fromSecretsManager(this.props.hasuraOptions.jwtSecret);
    }

    if (this.props.hasuraOptions?.secrets) {
      secrets = { ...secrets, ...this.props.hasuraOptions.secrets };
    }

    return secrets;
  }

  /**
   * Hasura doesn't like some punctuation in DB password or admin secret
   */
  private getHasuraSecret(id: string): secrets.Secret {
    return new secrets.Secret(this, id, {
      generateSecretString: {
        excludePunctuation: true,
      },
    });
  }
}

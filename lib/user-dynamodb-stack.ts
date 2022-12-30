import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'

export class UserDynamoDBStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        const table = new dynamodb.Table(this, 'User',{
                tableName: "User",
                partitionKey: {name: 'userId',  type: dynamodb.AttributeType.STRING},
                sortKey:{name: 'timestamp',type: dynamodb.AttributeType.STRING},

                removalPolicy: cdk.RemovalPolicy.DESTROY
            },
        )
        table.addGlobalSecondaryIndex({
            indexName: "followingId",
            partitionKey: {name: 'followingId',  type: dynamodb.AttributeType.STRING},
            sortKey:{name:'timestamp',type: dynamodb.AttributeType.STRING}
        })

    }
}

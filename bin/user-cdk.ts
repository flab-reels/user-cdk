#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {UserDynamoDBStack} from '../lib/user-dynamodb-stack';
import {UserEcsAppStack, UserPipelineStack} from "../lib/user-pipeline-stack";

const app = new cdk.App();
new UserDynamoDBStack(app, 'UserDynamoDBStack');

const userPipelineStack = new UserPipelineStack(app, 'UserPipelineStack')

new UserEcsAppStack(app,'UserEcsStackDeployedInPipeline',{
    image: userPipelineStack.tagParameterContainerImage,
})
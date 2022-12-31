import * as cdk from 'aws-cdk-lib';
import {aws_ecs_patterns, SecretValue} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline'
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import {SecurityGroup} from 'aws-cdk-lib/aws-ec2'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import {Protocol} from 'aws-cdk-lib/aws-elasticloadbalancingv2'

export class UserPipelineStack extends cdk.Stack {
    public readonly tagParameterContainerImage: ecs.TagParameterContainerImage;
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);


        const appEcrRepo = new ecr.Repository(this, 'user-ecr-repository',{
            repositoryName:'user-repository',

        });


        const appCodeDockerBuild = new codebuild.PipelineProject(this, 'user-docker-build', {
            projectName: "user-codebuild",
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2,
                privileged: true
            },
            environmentVariables: {
                REPOSITORY_URI: {
                    value: appEcrRepo.repositoryUri,
                },
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        "runtime-versions": {
                            java: 'corretto11',
                        },
                        commands: [

                            'echo Java version check',
                            'java -version',

                            'echo Logging in to Amazon ECR...',
                            '$(aws ecr get-login --region $AWS_DEFAULT_REGION --no-include-email)',

                        ]
                    },
                    build: {
                        commands: [
                            'echo Build started on `date`',
                            './gradlew bootBuildImage --imageName=$REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION',

                            'echo Pushing Docker Image',
                            'docker push $REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION',
                            'export imageTag=$CODEBUILD_RESOLVED_SOURCE_VERSION',
                            'echo imageTag=$CODEBUILD_RESOLVED_SOURCE_VERSION'
                        ],
                    },
                    post_build: {
                        commands: [
                            // "echo creating imagedefinitions.json dynamically",

                            "printf '[{\"name\":\"" + 'user-repository' + "\",\"imageUri\": \"" + appEcrRepo.repositoryUriForTag() + "${CODEBUILD_RESOLVED_SOURCE_VERSION}`\"}]' > imagedefinitions.json",

                            "echo Build completed on `date`"
                        ]
                    },
                },
                env:{
                    'exported-variables': [
                        'imageTag',
                    ],
                },
                cache: {
                    paths: '/root/.gradle/**/*',
                },
                artifacts: {
                    files: [
                        "imagedefinitions.json"
                    ],
                },

            }),
        });

        appEcrRepo.grantPullPush(appCodeDockerBuild);
        // create the ContainerImage used for the ECS application Stack
        this.tagParameterContainerImage = new ecs.TagParameterContainerImage(appEcrRepo);



        const cdkCodeBuild = new codebuild.PipelineProject(this, 'CdkCodeBuildProject', {
            projectName: "user-cdk-codebuild",
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
                privileged: true
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        commands: [
                            'npm install',
                            'npm install -g aws-cdk',
                            "n 16.15.1",
                        ],
                    },
                    build: {
                        commands: [
                            // synthesize the CDK code for the ECS application Stack
                            // 'npx cdk --version',
                            'npx cdk synth --verbose',
                        ],
                    },
                },
                artifacts: {
                    // store the entire Cloud Assembly as the output artifact
                    'base-directory': 'cdk.out',
                    'files': '**/*',
                },
            }),
        });



        /** 파이프라인 세션 단계별로 구별 할수 있게 처리*/
        const appCodeSourceOutput = new codepipeline.Artifact();
        const cdkCodeSourceOutput = new codepipeline.Artifact();
        const cdkCodeBuildOutput = new codepipeline.Artifact();

        const appCodeBuildAction = new codepipeline_actions.CodeBuildAction({
            actionName: 'user-docker-build-action',
            project: appCodeDockerBuild,
            input: appCodeSourceOutput,
        });

        const githubSourceAction = this.createUserGithubSourceAction(appCodeSourceOutput)
        const cdkSourceAction = this.createCDKGithubSourceAction(cdkCodeSourceOutput)

        new codepipeline.Pipeline(this, 'user-code-pipeline', {
            // artifactBucket: new s3.Bucket(this, 'ArtifactBucket', {
            //     bucketName:'user-cdk-bucket',
            //     removalPolicy: cdk.RemovalPolicy.DESTROY,
            // }),
            pipelineName:"user-pipeline",

            stages: [
                {
                    stageName: 'Source',
                    actions: [
                        /** SPRING BOOT SERVICE*/
                        githubSourceAction,


                        /** CDK CODE STACK BUILD*/
                        cdkSourceAction
                    ],
                },
                {
                    stageName: 'Build',
                    actions: [
                        /** SPRING BOOT SERVICE*/
                        appCodeBuildAction,


                        /** CDK CODE STACK BUILD*/
                        new codepipeline_actions.CodeBuildAction({
                            actionName: 'CdkCodeBuildAndSynth',
                            project: cdkCodeBuild,
                            input: cdkCodeSourceOutput,
                            outputs: [cdkCodeBuildOutput],
                        }),
                    ]
                },
                {
                    stageName: 'Deploy',
                    actions: [
                        new codepipeline_actions.CloudFormationCreateUpdateStackAction({
                            actionName: 'User_CloudFormation_CodeDeploy',
                            stackName: 'UserEcsStackDeployedInPipeline',
                            // this name has to be the same name as used below in the CDK code for the application Stack
                            templatePath: cdkCodeBuildOutput.atPath('UserEcsStackDeployedInPipeline.template.json'),
                            adminPermissions: true,
                            parameterOverrides: {
                                // read the tag pushed to the ECR repository from the CodyePipeline Variable saved by the application build step,
                                // and pass it as the CloudFormation Parameter for the tag
                                [this.tagParameterContainerImage.tagParameterName]: appCodeBuildAction.variable('imageTag'),
                            },
                        }),
                    ]
                },
            ],
        });


    }

    public createUserGithubSourceAction(sourceOutput: codepipeline.Artifact): codepipeline_actions.GitHubSourceAction {
        return new codepipeline_actions.GitHubSourceAction({
            actionName: 'user-pipeline-github',
            owner: 'flab-reels',
            repo: 'user',
            oauthToken: SecretValue.secretsManager('github_source_accesskey'),
            output: sourceOutput,
            branch: 'master', // default: 'master'
        });
    }

    public createCDKGithubSourceAction(sourceOutput: codepipeline.Artifact): codepipeline_actions.GitHubSourceAction {
        return new codepipeline_actions.GitHubSourceAction({
            actionName: 'user-pipeline-cdk',
            owner: 'flab-reels',
            repo: 'user-cdk',
            oauthToken: SecretValue.secretsManager('github_source_accesskey'),
            output: sourceOutput,
            branch: 'master', // default: 'master'
        });
    }






}

/**
 * 1. 위 파이프라인 스택이 끝나면 밑의 코드들은 CloudFormation 으로 돌리도록 설정함
 * 2. 위 파이프라인 스택에서 만든 ECR Tag를 가져와서 CloudFormation 에서 CDK DEPLOY를 실행하게 함
 * 3. 소스는 Github, CodeCommit 다 가능
 */

export interface EcsAppStackProps extends cdk.StackProps {
    readonly image: ecs.ContainerImage;
}


export class UserEcsAppStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EcsAppStackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, "user-vpc", {
            vpcName:"user-vpc",
            maxAzs: 3, // Default is all AZs in region
            natGateways:1
        });


        const cluster = new ecs.Cluster(this, 'Cluster', {
            vpc,
            clusterName:"user-cluster"
        })
        const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'userFargateDefinition', {
            memoryLimitMiB: 1024,
            cpu: 512,

        });
        const container = fargateTaskDefinition.addContainer("userServiceContainer", {
            // Use an image from Amazon ECR
            image: props.image,
            /** Spring Boot Application.yml
             * - 환경변수와, Secret값을 넣을 수 있다. 보안상으로 이런식으로 넣으면 Github에 올려도 충분히 보안을 형성 할 수 있다.
             *
             * - 스프링 부트 Application.yml 예시
             *   datasource:
             *     url: ${databaseUrl}
             *     username: ${databaseUser}
             *     password: ${databasePassword}
             *
             * - 위와 같이 Scope를 설정해주면 값이 대입이 되어 보안을 유지할 수 있게 된다.
             */
            environment:{
                'dynamodbEndpoint': "https://dynamodb.ap-northeast-2.amazonaws.com",
            },
            secrets : {
                'awsAccessKey' : ecs.Secret.fromSecretsManager(
                    new secretsmanager.Secret(this,'user-dynamodb-access',{
                        secretStringValue:SecretValue.secretsManager('AwsAccessKey')
                    })
                ),
                'awsSecretKey' : ecs.Secret.fromSecretsManager(
                    new secretsmanager.Secret(this,'user-dynamodb-secret',{
                        secretStringValue:SecretValue.secretsManager('AwsSecretKey')
                    })
                ),
            }

        });
        container.addPortMappings({
            containerPort: 8080,
            hostPort: 8080

        });



        const secGroup = new SecurityGroup(this, 'user-sg', {
            allowAllOutbound:true,
            securityGroupName: "user-sg",
            vpc:vpc,
        });

        secGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(80), 'SSH frm anywhere');
        secGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(8080), '');
        // secGroup.addIngressRule(secGroup, ec2.Port.allTraffic))


        const service = new ecs.FargateService(this, 'Service', {
            cluster,
            taskDefinition: fargateTaskDefinition,
            desiredCount: 1,
            securityGroups: [secGroup],
            circuitBreaker:{rollback:true},

        });

        const loadBalancer = new elbv2.NetworkLoadBalancer(this, 'user-alb',{
            vpc,
            internetFacing:true,
            // idleTimeout:Duration.seconds(300),

        })

        const listener = loadBalancer.addListener('user-listener',{
            port:80,
        })
        listener.addTargets('user-target',{
            port:80,
            targets:[service],
            protocol:elbv2.Protocol.HTTP,
            healthCheck:{
                protocol: elbv2.Protocol.HTTP,
                interval:cdk.Duration.seconds(60),
                path: "/actuator/health",
                port:"8080"
            }

        })

        new cdk.CfnOutput(this, "user-VPC-id",{value: vpc.vpcId})
        new cdk.CfnOutput(this,"user-nlb-arn",{value: loadBalancer.loadBalancerArn})

    }
}

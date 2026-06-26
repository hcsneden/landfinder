import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import { Construct } from 'constructs';

export class WebStack extends cdk.Stack {
  public readonly distributionUrl: string;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: `landfinder-web-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // Cache policy for HTML files — short TTL so deploys propagate quickly
    const htmlCachePolicy = new cloudfront.CachePolicy(this, 'HtmlCachePolicy', {
      cachePolicyName: 'landfinder-html-cache',
      defaultTtl: cdk.Duration.minutes(5),
      maxTtl: cdk.Duration.minutes(5),
      minTtl: cdk.Duration.seconds(0),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Vite hashes asset filenames — long TTL is safe
    const assetCachePolicy = new cloudfront.CachePolicy(this, 'AssetCachePolicy', {
      cachePolicyName: 'landfinder-asset-cache',
      defaultTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'LandFinder web app',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: htmlCachePolicy,
        compress: true,
      },
      additionalBehaviors: {
        // Vite puts hashed assets in /assets/ — cache them aggressively
        '/assets/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: assetCachePolicy,
          compress: true,
        },
      },
      // SPA: return index.html for any 403/404 so React Router handles routing
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US/Europe/Canada only — cheapest
    });

    this.distributionUrl = `https://${this.distribution.distributionDomainName}`;

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../apps/web/dist'))],
      destinationBucket: bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      memoryLimit: 256,
    });

    new cdk.CfnOutput(this, 'WebUrl', {
      value: this.distributionUrl,
      exportName: 'LandFinderWebUrl',
      description: 'CloudFront URL for the LandFinder web app',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      exportName: 'LandFinderDistributionId',
    });
  }
}

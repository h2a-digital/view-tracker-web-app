/** Non-secret build metadata, also usable by next.config and the auth proxy. */
export type Environment = Record<string, string | undefined>;
export type DeploymentEnvironment = 'development' | 'preview' | 'production';

export function deploymentEnvironment(
  env: Environment = {
    ...process.env,
    // Next.js inlines this non-secret value into each deployment artifact. Netlify's
    // build CONTEXT need not be present in the serverless or proxy runtime.
    APP_DEPLOYMENT_ENV: process.env.APP_DEPLOYMENT_ENV,
  }
): DeploymentEnvironment {
  // Either a preview build artifact or a preview runtime context blocks live access.
  // A copied production setting cannot override a preview deployment.
  if (env.CONTEXT && !['production', 'dev'].includes(env.CONTEXT)) return 'preview';
  if (env.APP_DEPLOYMENT_ENV && !['production', 'development'].includes(env.APP_DEPLOYMENT_ENV))
    return 'preview';
  if (env.CONTEXT === 'production' || env.APP_DEPLOYMENT_ENV === 'production') return 'production';
  if (env.CONTEXT === 'dev' || env.APP_DEPLOYMENT_ENV === 'development') return 'development';
  if (env.NETLIFY === 'true') return 'preview'; // Missing build context: fail closed.
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}
export function hostedPreview(env?: Environment) {
  return deploymentEnvironment(env) === 'preview';
}
export function hostedDeployment(env?: Environment) {
  return deploymentEnvironment(env) !== 'development';
}

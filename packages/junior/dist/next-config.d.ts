import { NextConfig } from 'next';

interface JuniorConfigOptions {
    dataDir?: string;
    skillsDir?: string;
    pluginsDir?: string;
    sentry?: boolean;
}
type NextConfigFactory = (phase: string, ctx: {
    defaultConfig: NextConfig;
}) => Promise<NextConfig> | NextConfig;
declare function withJunior(nextConfig?: NextConfig | NextConfigFactory, options?: JuniorConfigOptions): NextConfig | NextConfigFactory;

export { type JuniorConfigOptions, withJunior };

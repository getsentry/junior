type WebhookRouteContext = {
    params: Promise<{
        platform: string;
    }>;
};
declare function POST(request: Request, context: WebhookRouteContext): Promise<Response>;

export { POST };

type RouteContext = {
    params: Promise<{
        path: string[];
    }>;
};
declare function GET(request: Request, context: RouteContext): Promise<Response>;
declare function POST(request: Request, context: RouteContext): Promise<Response>;

export { GET, POST };

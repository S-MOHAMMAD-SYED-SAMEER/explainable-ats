// What every handler returns.
//
// A plain `{ status, body }` rather than an Express `Response`, so a handler is
// an ordinary function a test can call with an in-memory database and no HTTP
// server. Routes stay thin: parse the request, call the handler, send what it
// returns. No business logic lives in a route, so no business logic needs a
// port to be tested.

export type HandlerResult<T> = { status: number; body: T };

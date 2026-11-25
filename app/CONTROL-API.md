# Tangent app control API (v1)

The Tangent desktop app runs a small HTTP API on this computer so that Tangent for Chrome
(the browser extension) can see whether the private internet is on, switch it on and off, and
point the browser at it. It listens on `http://127.0.0.1:47611` and nowhere else.

## Who may call it

- The listener binds to 127.0.0.1 only.
- A request whose `Host` header is not `127.0.0.1:47611` or `localhost:47611` gets `403`
  (this stops DNS rebinding from a web page).
- A request with an `Origin` header gets `403` unless the origin starts with
  `chrome-extension://` or `moz-extension://`. Requests with no `Origin` are allowed.
- `OPTIONS` preflights are answered. Allowed headers: `authorization, content-type`.
  `Access-Control-Allow-Origin` echoes the allowed origin.
- Everything except `/v1/hello` and the two pairing calls needs `Authorization: Bearer <token>`.
  A missing or unknown token gets `401 {"error":"unpaired"}`.
- All bodies are JSON. Errors are `{"error":"<short code>"}` with a 4xx or 5xx status.

## Pairing

The extension pairs once. The person approves it inside the app.

- `GET /v1/hello` -> `200 {"app":"tangent","version":"<app version>","api":1}`
- `POST /v1/pair` body `{"client":"Tangent for Chrome"}` -> `200 {"request":"<id>"}`.
  The app shows "Allow Tangent for Chrome to control the private internet?" with Allow and Deny.
- `GET /v1/pair/<id>` -> `200 {"state":"waiting"}` | `{"state":"approved","token":"<token>"}`
  | `{"state":"denied"}` | `{"state":"expired"}`. A request expires after 2 minutes. The token is
  returned on the first read after approval and then the request is forgotten.

Tokens are random (32 bytes, base64url), kept in the app's data folder, and listed in the app
so the person can remove one.

## Status and control

`GET /v1/status` -> `200`

```json
{
  "connected": true,
  "connecting": false,
  "socks": { "host": "127.0.0.1", "port": 47612 },
  "hops": [ { "id": "<node id>" }, { "id": "<node id>" }, { "id": "<node id>" } ],
  "usage": { "bytesUp": 0, "bytesDown": 0 },
  "since": 1795618440414,
  "needsBalance": false,
  "error": null
}
```

- `socks` is `null` while not connected. The port is 47612 unless it was taken, so always read it.
- `hops` is the path of the circuit in use, first hop first, last hop (the one that reaches
  the open web) last. Empty while not connected or before the first circuit exists.
- `needsBalance` is true when traffic has stopped or is about to stop because the wallet in the
  app needs balance.
- `error` is a short sentence when the last connect failed, otherwise `null`.

`POST /v1/connect` -> starts the private internet, answers with the same object as status
(it may still say `"connecting": true`; poll status).

`POST /v1/disconnect` -> stops it, answers with the status object.

`POST /v1/open` body `{"view":"internet"|"wallet"|"computers"|"network"}` -> `200 {"ok":true}`.
Brings the app window to the front on that view.

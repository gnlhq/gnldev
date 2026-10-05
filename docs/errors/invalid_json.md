# invalid_json

**HTTP 400**

## What happened

The request body is not a JSON object: it did not parse as JSON, or it parsed as an array, a
string, a number or `null`. The `error` field says which.

## Why

Every route that takes a body reads it as a JSON object. A body that is not one used to be read as
an empty object, and the request then failed on a field it seemed to lack — "runId or workKey
required" for a body that did name one but was cut off, or, on the chat door, a 200 with "An error
occurred." in the stream. The body is the problem, so the answer names the body.

An empty body is read as `{}`: a route whose fields are all optional accepts it.

## What to do

Send `content-type: application/json` with a JSON object body. Check what your client actually
sends — a body built by string concatenation, a truncated proxy buffer, or a form encoding are the
usual causes.

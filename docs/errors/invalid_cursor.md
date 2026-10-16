# invalid_cursor

**HTTP 400**

## What happened

The reader's cursor — the `Last-Event-ID` header, `?after=`, the body's `lastEventId`, or `after` passed
to `gnl.stream()` / `gnl.follow()` — is not a cursor a run's stream gives. A cursor is an event's `seq`
(`42`), or `seq.offset` in the middle of an answer (`42.17`): whole numbers, each at most
`Number.MAX_SAFE_INTEGER`.

## Why

A cursor says "I hold everything up to here". One the server could not read used to be read as no
cursor at all, and the reader was sent the whole run again — every event it already had, a second
time. A number too long to hold exactly (`99999999999999999999999`) was read as `1e+23` and ended the
same way. Nothing in the request tells the server where the reader really is, so it refuses rather
than guess.

When `gnl.stream()` is given such a cursor the call is refused before the run is started or joined.

## What to do

Send back exactly what the stream gave you: the `id` of the last event you received (an EventSource
does this by itself), or what `cursor()` returned. To read a run from its start, send no cursor.

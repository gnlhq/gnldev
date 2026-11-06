// Makes a MongoDB generator process reproducible, after ./deterministic.mjs. Two things the driver does
// on its own that the fixed clock alone leaves to chance:
//   · every document inserted without an `_id` gets an ObjectId — 4 bytes of the clock, 5 random bytes per
//     process and a counter from a random start. Here: the fixed clock, fixed bytes, a counter from 0.
//   · its pool and monitor read the clock (`new Date()` per pool event, per handshake) on timers of their
//     own, so how far the shared clock (which moves 1 ms per read) has moved by any write of the writer's
//     depended on the run (measured: two runs of `queue-many` differed in `ts` by 3 ms from one write on).
//     Here a read from the driver's own code sees the clock without moving it.
// Patched on the `bson` the 0.16.0 install's driver loads (GNL_016_ROOT), which is the instance its
// `new ObjectId()` calls.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { now } from './deterministic.mjs';

const root = process.env.GNL_016_ROOT;
if (!root) throw new Error('GNL_016_ROOT is not set');

const Fixed = globalThis.Date;
const driverFrame = /[\\/]node_modules[\\/](mongodb|bson|mongodb-connection-string-url)[\\/]/;
const fromDriver = () => driverFrame.test(new Error().stack ?? '');
class DriverStillDate extends Fixed {
  constructor(...args) {
    if (args.length === 0 && fromDriver()) super(now());
    else super(...args);
  }
  static now() {
    return fromDriver() ? now() : Fixed.now();
  }
}
globalThis.Date = DriverStillDate;

const { ObjectId } = createRequire(join(root, 'node_modules', 'mongodb', 'package.json'))('bson');
let inc = 0;
ObjectId.generate = (time) => {
  const b = Buffer.alloc(12);
  b.writeUInt32BE((typeof time === 'number' ? time : Math.floor(now() / 1000)) >>> 0, 0);
  b.set([0x67, 0x6e, 0x6c, 0x00, 0x16], 4); // 'gnl', 0.16
  const n = inc++ & 0xffffff;
  b[9] = n >> 16; b[10] = (n >> 8) & 0xff; b[11] = n & 0xff;
  return b;
};

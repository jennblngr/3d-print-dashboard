// Live status of the printers on a Bambu Lab account, from Bambu's cloud message broker (MQTT).
// Listen only: this client subscribes to the printers' reports and never publishes anything,
// so it cannot command a printer, nor even ask one for its full status.
// Just enough of MQTT 3.1.1 for that is written here, to avoid a dependency.
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const HOST = 'us.mqtt.bambulab.com';
const KEEPALIVE_S = 60;
const MAX_PACKET = 1_000_000;

const text = s => {
  const b = Buffer.from(s);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};
function packet(type, body) {
  const len = [];
  let n = body.length;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n) byte |= 128;
    len.push(byte);
  } while (n);
  return Buffer.concat([Buffer.from([type, ...len]), body]);
}

// `onReport(printerId, message)` gets each report a printer sends; `onStatus(status)` is told
// 'on' once listening, 'off' when the connection drops (it comes back by itself) and 'refused'
// when Bambu turns the account down (tried again much later). Returns a function that stops.
export function watchPrinters({ uid, token, printerIds, onReport, onStatus }) {
  let socket = null;
  let stopped = false;
  let wait = 30_000;
  let timer = null;
  let ping = null;

  const retry = delay => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
    timer.unref();
  };

  function connect() {
    if (stopped) return;
    let buffer = Buffer.alloc(0);
    let refused = false;
    const s = (socket = tls.connect({ host: HOST, port: 8883, servername: HOST }));
    s.setTimeout(KEEPALIVE_S * 2000, () => s.destroy());
    s.on('secureConnect', () => {
      const flags = 0x80 | 0x40 | 0x02; // user name, password, clean session
      const head = Buffer.concat([text('MQTT'), Buffer.from([4, flags, 0, KEEPALIVE_S])]);
      s.write(packet(0x10, Buffer.concat([head, text('dash_' + randomBytes(6).toString('hex')), text(`u_${uid}`), text(token)])));
    });
    s.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let length = 0;
        let i = 1;
        for (let shift = 0; ; shift += 7, i++) {
          if (i >= buffer.length) return;
          length += (buffer[i] & 127) * 2 ** shift;
          if (!(buffer[i] & 128)) break;
          if (shift > 21) return s.destroy();
        }
        if (length > MAX_PACKET) return s.destroy();
        if (buffer.length < i + 1 + length) return;
        const type = buffer[0] >> 4;
        const qos = (buffer[0] >> 1) & 3;
        const body = buffer.subarray(i + 1, i + 1 + length);
        buffer = buffer.subarray(i + 1 + length);
        if (type === 2) {
          // CONNACK: 0 is accepted, anything else a refusal (bad or expired key, mostly)
          if (body[1] !== 0) {
            refused = true;
            return s.destroy();
          }
          wait = 30_000;
          const topics = printerIds.map(id => Buffer.concat([text(`device/${id}/report`), Buffer.from([0])]));
          s.write(packet(0x82, Buffer.concat([Buffer.from([0, 1]), ...topics])));
          ping = setInterval(() => s.write(packet(0xc0, Buffer.alloc(0))), (KEEPALIVE_S - 10) * 1000);
          ping.unref();
          onStatus('on');
        } else if (type === 9) {
          // SUBACK: 0x80 is a printer this account may not follow
          if (body.subarray(2).includes(0x80)) {
            refused = true;
            return s.destroy();
          }
        } else if (type === 3) {
          const topicLength = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + topicLength).toString();
          const payload = body.subarray(2 + topicLength + (qos ? 2 : 0));
          const id = /^device\/([\w-]+)\/report$/.exec(topic)?.[1];
          let message;
          try {
            message = JSON.parse(payload.toString());
          } catch {
            continue;
          }
          if (id && message && typeof message === 'object') onReport(id, message);
        }
      }
    });
    s.on('error', () => {});
    s.on('close', () => {
      clearInterval(ping);
      if (stopped || s !== socket) return;
      onStatus(refused ? 'refused' : 'off');
      if (refused) return retry(30 * 60_000);
      retry(wait);
      wait = Math.min(wait * 2, 10 * 60_000);
    });
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(ping);
    socket?.destroy();
  };
}

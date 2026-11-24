/*! YouTube 增强 · Egern 原生开关桥（由 rules/youtube/sync.py 生成，勿手改）
 *  内容上游：IBL3ND/js @ aa76cd9b4a323b55efa51b8cfe94d92a3dd20126（原始来源 Maasea/sgmodule, Apache-2.0）
 *  作用：把 env_schema 的 Toggle 读成 ctx.env → $argument JSON；上游代码自下一行起逐字节原样。
 *  本 run 锁定的 repo/commit/sha256 见 rules/youtube/SOURCE.lock（上游一变即自动变更）。
 */
export default async function (ctx) {
  var __ytEnv = (ctx && ctx.env) || {};
  var __ytDef = {blockUpload: false,blockShorts: false,autoHd: false,blockGames: false,blockVerticalLive: false,jumpAhead: false,blockStore: false,nativeDownload: false};
  var __ytArg = {};
  for (var __k in __ytDef) {
    var __v = __ytEnv[__k];
    var __raw = (__v === undefined || __v === null) ? "" : String(__v).trim();
    // 只有合法真值才开启；未设置 / 空 / false|0|off|no / 任意非法值一律关闭
    __ytArg[__k] = __raw === "" ? __ytDef[__k] : /^(true|1|on|yes)$/i.test(__raw);
  }
  try { globalThis.$argument = JSON.stringify(__ytArg); } catch (e) {}
        const CONFIG_KEY = "YouTubeConfig";

        const QUALITY_KEY = "YouTubeQuality";




        function main() {

            const path = $request.url.split("?")[0],

                platform = platformKey($request);

            try {

                let result = {};

                if (path.endsWith("/player/ad_break")) result = emptyPlayback();

                else if (path.endsWith("/log_event"))

                    result = prepareLogEvent($request.headers, platform);

                else if (path.endsWith("/initplayback"))

                    result = preparePlayback($request.body, platform);

                else if (

                    path.endsWith("/youtubei/v1/player") &&

                    readOptions().nativeDownload === true

                )

                    result = prepareOfflineDownload($request.body);

                else if (path.endsWith("/videoplayback")) {

                    const options = readOptions();

                    if (

                        options.autoHd !== false &&

                        $request.body instanceof Uint8Array &&

                        $request.body.length

                    )

                        result = {

                            body: forceHighestQuality($request.body, $request.url),

                        };

                }

                $done(result);

            } catch (error) {

                console.log("YouTube request: " + error);

                $done({});

            }

        }

        function emptyPlayback() {

            return {

                response: {

                    status: 200,

                    headers: { "Content-Type": "application/x-protobuf" },

                    body: new Uint8Array(),

                },

            };

        }

        function prepareLogEvent(requestHeaders, platform) {

            const headers = { ...requestHeaders };

            if (!readConfig()[platform]?.clientKey)

                for (const name of Object.keys(headers))

                    if (name.toLowerCase() === "x-youtube-hot-hash-data")

                        delete headers[name];

            return { headers };

        }

        function preparePlayback(body, platform) {

            const key = readConfig()[platform]?.encryptKey;

            const encrypted = body instanceof Uint8Array && bytesField(body, 3);

            const clientKey = encrypted && bytesField(encrypted, 5);

            if (key && clientKey && sameBytes(clientKey, decodeBase64(key)))

                return {};

            return {};

        }


        function prepareOfflineDownload(body) {

            if (!(body instanceof Uint8Array) || !body.length) return {};

            const fields = wireFields(body),

                offline = fields.filter((field) => field.no === 8),

                params = fields.filter((field) => field.no === 12);

            if (

                offline.length !== 1 ||

                offline[0].wire !== 0 ||

                offline[0].data.length !== 1 ||

                offline[0].data[0] !== 1 ||

                params.length !== 1 ||

                params[0].wire !== 2 ||

                params[0].data.length !== 0

            )

                return {};





            return {

                body: concatBytes(

                    fields

                        .filter((field) => field !== params[0])

                        .map((field) => field.raw),

                ),

            };

        }




        function setQuality(bytes, quality) {





            const values = new Map(

                    quality

                        ? [

                              [13, 0],

                              [14, 2],

                              [16, quality.height],

                              [21, quality.height],

                              [26, 3],

                              [30, 0],

                          ]

                        : [

                              [16, 4320],

                              [26, 1],

                          ],

                ),

                seen = new Set(),

                chunks = [];

            for (const field of wireFields(bytes)) {

                if (field.wire === 0 && values.has(field.no)) {

                    chunks.push(varint(field.no * 8), varint(values.get(field.no)));

                    seen.add(field.no);

                } else chunks.push(field.raw);

            }

            for (const [no, value] of values)

                if (!seen.has(no)) chunks.push(varint(no * 8), varint(value));

            return concatBytes(chunks);

        }

        function selectQuality(fields, url) {

            try {

                const match = /[?&]id=([^&]+)/.exec(url);

                if (!match) return;

                const quality =

                    readConfig(QUALITY_KEY)?.[decodeURIComponent(match[1])];

                if (

                    !Number.isInteger(quality?.height) ||

                    quality.height <= 0 ||

                    quality.height > 0x7fffffff ||

                    !Array.isArray(quality.itags)

                )

                    return;

                const config = fields.find(

                    (field) => field.no === 5 && field.wire === 2,

                );

                const signed = config && bytesField(config.data, 1);

                if (!signed) return;





                const formats = wireFields(signed)

                    .filter((field) => {

                        if (field.no !== 6 || field.wire !== 2) return false;

                        const itag = wireFields(field.data).find(

                            (field) => field.no === 1 && field.wire === 0,

                        );

                        if (!itag) return false;

                        let value = 0,

                            scale = 1;

                        for (const byte of itag.data) {

                            value += (byte & 127) * scale;

                            scale *= 128;

                        }

                        return quality.itags.includes(value);

                    })

                    .map((field) => field.data);

                return formats.length

                    ? { height: quality.height, formats }

                    : undefined;

            } catch {

                return undefined;

            }

        }

        function forceHighestQuality(bytes, url) {

            const fields = wireFields(bytes),

                quality = selectQuality(fields, url);

            const chunks = [];

            let found = false;

            for (const field of fields) {

                if (field.no === 1 && field.wire === 2) {

                    const state = setQuality(field.data, quality);

                    chunks.push(varint(10), varint(state.length), state);

                    found = true;

                } else if (quality && field.no === 17 && field.wire === 2) {

                    continue;

                } else chunks.push(field.raw);

            }

            if (!found) {

                const state = setQuality(new Uint8Array(), quality);

                chunks.push(varint(10), varint(state.length), state);

            }

            if (quality)

                for (const format of quality.formats)

                    chunks.push(varint(17 * 8 + 2), varint(format.length), format);

            return concatBytes(chunks);

        }




        function readOptions(defaults = {}) {

            return typeof $argument === "string" && !$argument.includes("{{{")

                ? { ...defaults, ...JSON.parse($argument) }

                : defaults;

        }

        function platformKey(request) {

            return Object.entries(request.headers ?? {}).some(

                ([name, value]) =>

                    name.toLowerCase() === "user-agent" && /music/i.test(value),

            )

                ? "youtubeMusic"

                : "youtube";

        }

        function readConfig(key = CONFIG_KEY) {

            try {

                return JSON.parse($persistentStore.read(key) || "{}");

            } catch {

                return {};

            }

        }

        function writeConfig(config) {

            $persistentStore.write(JSON.stringify(config), CONFIG_KEY);

        }

        function clearKeys(platform) {

            const config = readConfig();

            if (config[platform]) {

                delete config[platform];

                writeConfig(config);

            }

        }




        function bytesField(bytes, number) {

            return wireFields(bytes).find(

                (field) => field.no === number && field.wire === 2,

            )?.data;

        }

        function concatBytes(chunks) {

            const result = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));

            let offset = 0;

            for (const bytes of chunks) {

                result.set(bytes, offset);

                offset += bytes.length;

            }

            return result;

        }

        function sameBytes(a, b) {

            return (

                a === b ||

                (a.length === b.length && a.every((value, i) => value === b[i]))

            );

        }

        function varint(value) {

            const bytes = [];

            do {

                bytes.push(value % 128 | (value > 127 ? 128 : 0));

                value = Math.floor(value / 128);

            } while (value);

            return new Uint8Array(bytes);

        }

        function wireFields(bytes) {

            const fields = [];

            let offset = 0;

            function read() {

                let value = 0,

                    scale = 1;

                for (let i = 0; i < 5; i++) {

                    if (offset >= bytes.length)

                        throw new Error("Truncated protobuf varint");

                    const byte = bytes[offset++];

                    value += (byte & 127) * scale;

                    if (!(byte & 128)) {

                        if (value > 0xffffffff)

                            throw new Error("Protobuf length/tag overflow");

                        return value;

                    }

                    scale *= 128;

                }

                throw new Error("Invalid protobuf varint");

            }

            while (offset < bytes.length) {

                const start = offset,

                    tag = read(),

                    no = Math.floor(tag / 8),

                    wire = tag % 8;

                if (!no) throw new Error("Invalid protobuf field");

                let payloadStart = offset;

                if (wire === 2) {

                    const length = read();

                    payloadStart = offset;

                    offset += length;

                } else if (wire === 1) offset += 8;

                else if (wire === 5) offset += 4;

                else if (wire === 0) {

                    let count = 0,

                        byte;

                    do {

                        if (offset >= bytes.length || count++ === 10)

                            throw new Error("Invalid protobuf integer");

                        byte = bytes[offset++];

                        if (count === 10 && byte > 1)

                            throw new Error("Protobuf integer overflow");

                    } while (byte & 128);

                } else throw new Error("Unsupported protobuf wire type " + wire);

                if (offset > bytes.length)

                    throw new Error("Truncated protobuf field");

                fields.push({

                    no,

                    wire,

                    data: bytes.subarray(payloadStart, offset),

                    raw: bytes.subarray(start, offset),

                });

            }

            return fields;

        }

        function decodeBase64(value) {

            const alphabet =

                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

            let buffer = 0,

                bits = 0;

            const output = [];

            for (const character of value.replace(/-/g, "+").replace(/_/g, "/")) {

                if (/\s|=/.test(character)) continue;

                const index = alphabet.indexOf(character);

                if (index < 0) throw new Error("Invalid base64 key");

                buffer = (buffer << 6) | index;

                bits += 6;

                if (bits >= 8) {

                    bits -= 8;

                    output.push((buffer >>> bits) & 255);

                }

            }

            return new Uint8Array(output);

        }


        main();

}

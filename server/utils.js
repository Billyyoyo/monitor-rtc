const {Readable} = require('stream');

// Converts a string (SDP) to a stream so it can be piped into the FFmpeg process
module.exports.convertStringToStream = (stringToConvert) => {
    const stream = new Readable();
    stream._read = () => {
    };
    stream.push(stringToConvert);
    stream.push(null);

    return stream;
};

// Gets codec information from rtpParameters
module.exports.getCodecInfoFromRtpParameters = (kind, rtpParameters) => {
    return {
        payloadType: rtpParameters.codecs[0].payloadType,
        codecName: rtpParameters.codecs[0].mimeType.replace(`${kind}/`, ''),
        clockRate: rtpParameters.codecs[0].clockRate,
        channels: kind === 'audio' ? rtpParameters.codecs[0].channels : undefined
    };
};

module.exports.getClientAddress = (req) => {
    const ip = req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        req.connection.socket.remoteAddress;
    const port = req.connection.remotePort ||
        req.socket.remotePort ||
        req.connection.socket.remotePort;
    return `${ip}:${port}`
}
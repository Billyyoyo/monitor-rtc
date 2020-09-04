module.exports = {
    httpIp: '0.0.0.0',
    httpPort: 3000,
    httpPeerStale: 15000,

    sslCrt: './cert/localhost.crt',
    sslKey: './cert/localhost.key',

    mediasoup: {
        worker: {
            rtcMinPort: 40000,
            rtcMaxPort: 50000,
            logLevel: 'debug',
            logTags: [
                'info',
                'ice',
                'dtls',
                'rtp',
                'srtp',
                'rtcp',
                // 'rtx',
                // 'bwe',
                // 'score',
                // 'simulcast',
                // 'svc'
            ],
        },
        router: {
            mediaCodecs:
                [
                    {
                        kind: 'audio',
                        mimeType: 'audio/opus',
                        clockRate: 48000,
                        channels: 2
                    },
                    {
                        kind: 'video',
                        mimeType: 'video/VP8',
                        clockRate: 90000,
                        parameters:
                            {
//                'x-google-start-bitrate': 1000
                        }
                    },
                    {
                        kind: 'video',
                        mimeType: 'video/h264',
                        clockRate: 90000,
                        parameters:
                            {
                                'packetization-mode': 1,
                                'profile-level-id': '4d0032',
                                'level-asymmetry-allowed': 1,
//						  'x-google-start-bitrate'  : 1000
                        }
                    },
                    {
                        kind: 'video',
                        mimeType: 'video/h264',
                        clockRate: 90000,
                        parameters:
                            {
                                'packetization-mode': 1,
                                'profile-level-id': '42e01f',
                                'level-asymmetry-allowed': 1,
//						  'x-google-start-bitrate'  : 1000
                        }
                    }
                ]
        },
        webRtcTransport: {
            listenIps: [
                // { ip: '127.0.0.1', announcedIp: null },
                // { ip: '192.168.1.113', announcedIp: null },
                // { ip: '192.168.0.109', announcedIp: null },
                {ip: '10.8.240.133', announcedIp: null},
            ],
            initialAvailableOutgoingBitrate: 800000,
        },
        plainRtpTransport: {
            listenIp: '127.0.0.1',
            rtcpMux: true,
            comedia: false
        }
    },
    log: {
        appenders: {
            console: {
                type: 'console'
            },
            access: {
                type: 'dateFile',
                filename: 'logs/access',
                pattern: "-yyyy-MM-dd.txt",
                compress: true,
                daysToKeep: 2,
            },
            logic: {
                type: 'dateFile',
                filename: 'logs/logic',
                pattern: "-yyyy-MM-dd.txt",
                compress: true,
                daysToKeep: 2,
            },
            ffmpeg: {
                type: 'dateFile',
                filename: 'logs/ffmpeg',
                pattern: "-yyyy-MM-dd.txt",
                compress: true,
                daysToKeep: 2,
            }
        },
        categories: {
            default: {
                appenders: ['console'],
                level: 'debug'
            },
            access: {
                appenders: ['console', 'access'],
                level: ['info']
            },
            logic: {
                appenders: ['console', 'logic'],
                level: ['info']
            },
            ffmpeg: {
                appenders: ['console', 'ffmpeg'],
                level: ['info']
            }
        }
    }
};

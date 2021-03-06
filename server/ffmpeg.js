// Class to handle child process used for running FFmpeg
const debugModule = require('debug')
const child_process = require('child_process');
const { EventEmitter } = require('events');

const { createSdpText } = require('./sdp');
const { convertStringToStream } = require('./utils');

const log = require('./logger').getLogger('ffmpeg')

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './files';

module.exports = class FFmpeg {
  constructor (rtpParameters) {
    this._rtpParameters = rtpParameters;
    this._process = undefined;
    this._observer = new EventEmitter();
    this._createProcess();
  }

  _createProcess () {
    const sdpString = createSdpText(this._rtpParameters);
    const sdpStream = convertStringToStream(sdpString);

    log.info('createProcess() [sdpString:%s]', sdpString);

    this._process = child_process.spawn('/home/billyyoyo/sdk/ffmpeg/bin/bin/ffmpeg', this._commandArgs);

    if (this._process.stderr) {
      this._process.stderr.setEncoding('utf-8');

      this._process.stderr.on('data', data =>
        log.debug(`process::data [data:${data}]`)
      );
    }

    if (this._process.stdout) {
      this._process.stdout.setEncoding('utf-8');

      this._process.stdout.on('data', data => 
        log.debug(`process::data [data:${data}]`)
      );
    }

    this._process.on('message', message =>
      log.debug(`process::message [message:${message}]`)
    );

    this._process.on('error', error =>
      log.error(`process::error [error:${error}]`)
    );

    this._process.once('close', () => {
      log.info('process::close');
      this._observer.emit('process-close');
    });

    sdpStream.on('error', error =>
      log.error(`sdpStream::error [error:${error}]`)
    );

    // Pipe sdp stream to the ffmpeg process
    sdpStream.resume();
    sdpStream.pipe(this._process.stdin);
  }

  kill () {
    log.info(`kill() [pid:${this._process.pid}]`);
    this._process.kill('SIGINT');
  }

  get _commandArgs () {
    let commandArgs = [
      '-loglevel',
      'debug',
      '-protocol_whitelist',
      'pipe,udp,rtp',
      '-fflags',
      '+genpts',
      '-f',
      'sdp',
      '-i',
      'pipe:0'
    ];

    commandArgs = commandArgs.concat(this._videoArgs);
    commandArgs = commandArgs.concat(this._audioArgs);

    commandArgs = commandArgs.concat([
      '-flags',
      '+global_header',
      `${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.webm`
    ]);

    log.info(`commandArgs:${commandArgs}`);

    return commandArgs;
  }

  get _videoArgs () {
    return [
      '-map',
      '0:v:0',
      '-c:v',
      'copy'
    ];
  }

  get _audioArgs () {
    return [
      '-map',
      '0:a:0',
      '-strict', // libvorbis is experimental
      '-2',
      '-c:a',
      'copy'
    ];
  }
}

// Port used for the gstreamer process to receive RTP from mediasoup 
const debugModule = require('debug')

const err = debugModule('app:ERROR')

const MIN_PORT = 50000;
const MAX_PORT = 59999;
const TIMEOUT = 400;

const takenPortSet = new Set();

module.exports.getPort = async () => {
  let port = getRandomPort();

  while(takenPortSet.has(port)) {
    port = getRandomPort();

    try {
      // Check that the port is available to use
      await isPortOpen(port);
    } catch (error) {
      err(`getPort() port is taken [port:${port}]`);
      takenPortSet.add(port);
    }
  }

  takenPortSet.add(port);

  return port;
};

module.exports.releasePort = (port) => takenPortSet.delete(port);

const getRandomPort = () => Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1) + MIN_PORT); 

// Users a socket to check that the port is open
const isPortOpen = (port) => {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve); 
    
    socket.setTimeout(TIMEOUT);
    socket.once('timeout', () => reject);
    socket.once('error', (error) => reject());

    socket.connect(port, '127.0.0.1');
  });
};

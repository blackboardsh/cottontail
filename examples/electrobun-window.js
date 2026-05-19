console.log('starting cottontail electrobun window example');

const windowId = electrobun.createWindow({
  title: 'Cottontail x Electrobun',
  width: 960,
  height: 640,
  x: 120,
  y: 120,
  quitOnClose: true,
});

console.log(`window created: ${windowId}`);
console.log('close the window to exit');

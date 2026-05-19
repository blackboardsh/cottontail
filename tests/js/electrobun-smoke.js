const windowId = electrobun.createWindow({
  title: 'cottontail electrobun smoke',
  width: 320,
  height: 200,
  hidden: true,
  activate: false,
  quitOnClose: false,
});

if (!(windowId > 0)) {
  throw new Error('expected electrobun.createWindow() to return a window id');
}

console.log('electrobun smoke passed');
electrobun.quit();

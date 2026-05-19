console.log('fixture main starting');

const windowId = electrobun.createWindow({
  title: 'cottontail fixture',
  width: 320,
  height: 200,
  hidden: true,
  activate: false,
  quitOnClose: false,
});

console.log(`fixture window ${windowId}`);
electrobun.quit();

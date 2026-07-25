const received = Array(10).fill(false);

process.on("uncaughtException", (error) => {
  received[error] = true;
  if (received.every(Boolean)) process.disconnect();
});

process.on("message", (message) => {
  throw message;
});

process.send("ready");

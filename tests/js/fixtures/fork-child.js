process.on("message", (message) => {
  process.send({ echo: message.value });
  process.exit(0);
});

process.send({ ready: true });

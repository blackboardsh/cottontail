const readyAt = Date.now() + 1_500;
while (Date.now() < readyAt) {}

const onMessage = (message) => {
  process.send({ size: String(message?.payload ?? "").length }, (error) => {
    if (error) throw error;
    process.removeListener("message", onMessage);
  });
};

process.on("message", onMessage);

const host = window.CanvasTTYPlugin;
const text = document.querySelector("#text");
const send = document.querySelector("#send");
const result = document.querySelector("#result");

send.addEventListener("click", async () => {
  result.textContent = "Calling…";
  try {
    const reply = await host.service.request("echo", "echo", { text: text.value });
    result.textContent = `Echo #${reply.count}: ${reply.echo.text}`;
  } catch (error) {
    // Not trusted yet, disabled, crashed or timed out: the host returns an error, never a reply.
    result.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
});

// Write-only: the page saves the token into the plugin's secrets and asks the service whether it can read it.
document.querySelector("#save-token").addEventListener("click", async () => {
  const token = document.querySelector("#token");
  await host.secrets.set("token", token.value);
  token.value = "";
  result.textContent = "Token saved.";
});
document.querySelector("#check-token").addEventListener("click", async () => {
  try {
    const reply = await host.service.request("echo", "token");
    result.textContent = reply.set ? "The service sees a token." : "No token is set.";
  } catch (error) {
    result.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
});

host.service.onEvent(({ serviceId, event, data }) => {
  document.body.dataset.lastEvent = `${serviceId}:${event}:${data?.count ?? ""}`;
});

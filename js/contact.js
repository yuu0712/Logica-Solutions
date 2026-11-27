const form = document.getElementById("requestForm");
const button = document.getElementById("submitButton");
const message = document.getElementById("message");

const idleLabel = button.textContent;
const service = form.elements.topic;
const topic = new URLSearchParams(location.search).get("topic");
if (service && Array.from(service.options).some((option) => option.value === topic)) {
  service.value = topic;
}

let previousSubmission;

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  message.textContent = "";
  button.disabled = true;
  button.textContent = "送信中...";

  try {
    const data = Object.fromEntries(new FormData(form));

    const payload = JSON.stringify(data);
    if (previousSubmission?.payload !== payload) {
      previousSubmission = { payload, requestId: crypto.randomUUID() };
    }
    data.requestId = previousSubmission.requestId;

    const response = await fetch("/api/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.ok !== true) {
      throw new Error(result.error || "送信に失敗しました");
    }

    form.reset();
    previousSubmission = undefined;
    message.textContent = form.dataset.success;
  } catch (error) {
    message.textContent = error instanceof TypeError ? "通信に失敗しました。時間をおいて再度お試しください。" : error.message || "エラーが発生しました。";
  } finally {
    button.disabled = false;
    button.textContent = idleLabel;
  }
});

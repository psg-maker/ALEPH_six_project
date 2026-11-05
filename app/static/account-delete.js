(() => {
  "use strict";

  const openButton = document.getElementById("account-delete-open");
  const dialog = document.getElementById("account-delete-dialog");
  const form = document.getElementById("account-delete-form");
  const cancelButton = document.getElementById("account-delete-cancel");
  const errorBox = document.getElementById("account-delete-error");
  const submitButton = document.getElementById("account-delete-submit");
  const currentPassword = document.getElementById("account-delete-password");
  const confirmation = document.getElementById("account-delete-confirmation");
  let pending = false;

  function setPending(value) {
    pending = value;
    openButton.disabled = value;
    cancelButton.disabled = value;
    submitButton.disabled = value;
    currentPassword.disabled = value;
    confirmation.disabled = value;
    submitButton.textContent = value ? "삭제 중…" : "계정과 모든 자료 삭제";
  }

  function clearForm() {
    form.reset();
    errorBox.textContent = "";
    errorBox.hidden = true;
  }

  openButton.addEventListener("click", () => {
    if (pending) return;
    clearForm();
    dialog.showModal();
  });

  cancelButton.addEventListener("click", () => {
    if (pending) return;
    dialog.close();
  });

  dialog.addEventListener("close", clearForm);
  dialog.addEventListener("cancel", (event) => {
    if (pending) event.preventDefault();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    errorBox.hidden = true;

    if (confirmation.value !== "계정 삭제") {
      errorBox.textContent = "확인 문구에 '계정 삭제'를 정확히 입력해주세요.";
      errorBox.hidden = false;
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/auth/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword.value,
          confirmation: confirmation.value,
        }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        if (response.status === 401 && data?.detail === "로그인이 필요합니다.") {
          window.alephSession.checkResponse(response);
        }
        errorBox.textContent = typeof data?.detail === "string"
          ? data.detail : "계정을 삭제하지 못했습니다.";
        errorBox.hidden = false;
        return;
      }

      clearForm();
      dialog.close();
      window.location.replace("/login");
    } catch {
      errorBox.textContent = "처리 결과를 확인하지 못했습니다. 다시 시도하거나 로그인 상태를 확인해주세요.";
      errorBox.hidden = false;
    } finally {
      setPending(false);
    }
  });

  setPending(false);
})();

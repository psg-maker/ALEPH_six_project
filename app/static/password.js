(() => {
  "use strict";

  const openButton = document.getElementById("password-open");
  const dialog = document.getElementById("password-dialog");
  const form = document.getElementById("password-form");
  const cancelButton = document.getElementById("password-cancel");
  const saveButton = document.getElementById("password-save");
  const errorBox = document.getElementById("password-error");

  const currentPassword = document.getElementById("current-password");
  const newPassword = document.getElementById("new-password");
  const confirmation = document.getElementById("confirm-password");

  let pending = false;

  function clearForm() {
    form.reset();
    errorBox.textContent = "";
    errorBox.hidden = true;
  }

  function setPending(value) {
    pending = value;
    openButton.disabled = value;
    cancelButton.disabled = value;
    saveButton.disabled = value;
    currentPassword.disabled = value;
    newPassword.disabled = value;
    confirmation.disabled = value;
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

    if (newPassword.value !== confirmation.value) {
      errorBox.textContent = "새 비밀번호와 확인 입력이 다릅니다.";
      errorBox.hidden = false;
      return;
    }

    setPending(true);

    try {
      const response = await fetch("/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          current_password: currentPassword.value,
          new_password: newPassword.value,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        if (
          response.status === 401 &&
          data?.detail === "로그인이 필요합니다."
        ) {
          window.alephSession.checkResponse(response);
        }

        errorBox.textContent =
          typeof data?.detail === "string"
            ? data.detail
            : "비밀번호를 변경하지 못했습니다.";
        errorBox.hidden = false;
        return;
      }

      clearForm();
      dialog.close();
      window.location.replace("/login");
    } catch {
      errorBox.textContent = "요청을 처리하지 못했습니다. 다시 시도해주세요.";
      errorBox.hidden = false;
    } finally {
      setPending(false);
    }
  });

  setPending(false);
})();
(() => {
  "use strict";

  const form = document.getElementById("auth-form");
  const username = document.getElementById("auth-username");
  const password = document.getElementById("auth-password");
  const button = document.getElementById("auth-submit");
  const errorBox = document.getElementById("auth-error");
  const title = document.getElementById("auth-title");
  const statusBox = document.getElementById("auth-status");
  const toggle = document.getElementById("auth-toggle");

  let pending = false;
  let mode = "login";

  function setMode(nextMode) {
    mode = nextMode;
    const registering = mode === "register";

    title.textContent = registering ? "회원가입" : "로그인";
    button.textContent = registering ? "회원가입" : "로그인";
    toggle.textContent = registering
      ? "이미 계정이 있나요? 로그인"
      : "계정이 없나요? 회원가입";

    password.autocomplete = registering
      ? "new-password"
      : "current-password";

    password.value = "";
    errorBox.hidden = true;
    statusBox.hidden = true;
  }

  toggle.addEventListener("click", () => {
    if (pending) return;
    setMode(mode === "login" ? "register" : "login");
  });
  
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (pending || !form.reportValidity()) {
      return;
    }

    pending = true;
    button.disabled = true;
    username.disabled = true;
    password.disabled = true;
    errorBox.hidden = true;
    statusBox.hidden = true;
    toggle.disabled = true;

    try {
      const response = await fetch(`/auth/${mode}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: username.value.trim(),
          password: password.value,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        errorBox.textContent =
          typeof data?.detail === "string"
            ? data.detail
            : "로그인하지 못했습니다.";
        errorBox.hidden = false;
        return;
      }

      if (mode === "register") {
        username.value = username.value.trim();
        setMode("login");
        statusBox.textContent = "회원가입이 완료됐습니다. 로그인해주세요.";
        statusBox.hidden = false;
        return;
      }

      password.value = "";
      window.location.assign("/");
    } catch {
      errorBox.textContent = "서버에 연결하지 못했습니다. 다시 시도해주세요.";
      errorBox.hidden = false;
    } finally {
      pending = false;
      button.disabled = false;
      username.disabled = false;
      password.disabled = false;
      toggle.disabled = false;
    }
  });

  button.disabled = false;
})();
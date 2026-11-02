(() => {
  "use strict";

  let redirecting = false;

  window.alephSession = {
    checkResponse(response) {
      if (response.status === 401) {
        if (!redirecting) {
          redirecting = true;
          window.location.replace("/login");
        }

        throw new Error("로그인이 만료됐습니다. 다시 로그인해주세요.");
      }

      return response;
    },
  };

  const button = document.getElementById("logout-button");
  const errorBox = document.getElementById("session-error");

  let pending = false;

  button.addEventListener("click", async () => {
    if (pending) return;

    pending = true;
    button.disabled = true;
    button.textContent = "로그아웃 중…";
    errorBox.hidden = true;

    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        errorBox.textContent =
          typeof data?.detail === "string"
            ? data.detail
            : "로그아웃하지 못했습니다.";
        errorBox.hidden = false;
        return;
      }

      window.location.replace("/login");
    } catch {
      errorBox.textContent = "서버에 연결하지 못했습니다. 다시 시도해주세요.";
      errorBox.hidden = false;
    } finally {
      pending = false;
      button.disabled = false;
      button.textContent = "로그아웃";
    }
  });

  button.disabled = false;
})();
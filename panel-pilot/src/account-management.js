async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Account request failed (${response.status})`);
  return payload;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const labels = { books: "Books", manga: "Manga", comic: "Comics", webtoon: "Webtoons" };

export async function initializeAccountManagement({ account }) {
  const name = document.querySelector("#current-account-name");
  const access = document.querySelector("#current-account-access");
  const administration = document.querySelector("#account-administration");
  const list = document.querySelector("#account-list");
  const form = document.querySelector("#create-account-form");
  const note = document.querySelector("#account-management-note");
  if (!name || !access) return;
  name.textContent = account.displayName || account.username;
  access.textContent = `Signed in as ${account.username} · ${(account.contentTypes || []).map((value) => labels[value] || value).join(", ")}`;
  if (!account.isAdmin || !administration || !list || !form) return;
  administration.hidden = false;

  async function renderAccounts() {
    const payload = await request("/api/accounts");
    list.replaceChildren();
    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    accounts.forEach((entry) => {
      const card = element("article", "account-card");
      const heading = element("div", "account-card-heading");
      const identity = element("span");
      identity.append(element("strong", "", entry.displayName), element("small", "", `@${entry.username}${entry.isAdmin ? " · Owner" : ""}`));
      heading.append(identity);
      const content = element("fieldset", "account-content-types");
      const legend = element("legend", "", "Enabled content");
      content.append(legend);
      Object.entries(labels).forEach(([value, label]) => {
        const option = element("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = value;
        checkbox.checked = Array.isArray(entry.contentTypes) && entry.contentTypes.includes(value);
        checkbox.disabled = entry.isAdmin || value !== "books";
        if (value !== "books" && !entry.isAdmin) {
          checkbox.title = "Add a dedicated Suwayomi service for this account before enabling visual titles.";
        }
        option.append(checkbox, document.createTextNode(` ${label}`));
        content.append(option);
      });
      const actions = element("div", "button-row account-card-actions");
      if (!entry.isAdmin) {
        const saveAccess = element("button", "", "Save access");
        saveAccess.type = "button";
        saveAccess.addEventListener("click", async () => {
          const contentTypes = [...content.querySelectorAll("input:checked")].map((input) => input.value);
          saveAccess.disabled = true;
          try {
            await request(`/api/accounts/${encodeURIComponent(entry.id)}/content`, {
              method: "POST", body: JSON.stringify({ contentTypes }),
            });
            note.textContent = `${entry.displayName}'s content access was updated.`;
          } catch (error) {
            note.textContent = error.message;
          } finally {
            saveAccess.disabled = false;
          }
        });
        actions.append(saveAccess);
      }
      card.append(heading, content, actions);
      if (!entry.isAdmin) {
        const password = document.createElement("input");
        password.type = "password";
        password.autocomplete = "new-password";
        password.placeholder = "New password";
        password.minLength = 12;
        password.setAttribute("aria-label", `New password for ${entry.displayName}`);
        const reset = element("button", "", "Reset password");
        reset.type = "button";
        reset.addEventListener("click", async () => {
          if (!password.value) {
            password.setCustomValidity("Enter a password of at least 12 characters.");
            password.reportValidity();
            return;
          }
          password.setCustomValidity("");
          reset.disabled = true;
          try {
            await request(`/api/accounts/${encodeURIComponent(entry.id)}/password`, {
              method: "POST", body: JSON.stringify({ password: password.value }),
            });
            password.value = "";
            note.textContent = `${entry.displayName}'s password was reset and their other sessions were signed out.`;
          } catch (error) {
            note.textContent = error.message;
          } finally {
            reset.disabled = false;
          }
        });
        const passwordRow = element("div", "account-password-row");
        passwordRow.append(password, reset);
        card.append(passwordRow);
      }
      list.append(card);
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    const data = new FormData(form);
    const contentTypes = data.getAll("contentTypes");
    submit.disabled = true;
    note.textContent = "Creating account…";
    try {
      const payload = await request("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          displayName: data.get("displayName"), username: data.get("username"),
          password: data.get("password"), contentTypes,
        }),
      });
      form.reset();
      form.querySelector('[value="books"]').checked = true;
      note.textContent = `${payload.account.displayName}'s account is ready. They can sign in at this same Panels address.`;
      await renderAccounts();
    } catch (error) {
      note.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  try {
    await renderAccounts();
  } catch (error) {
    note.textContent = error.message;
  }
}

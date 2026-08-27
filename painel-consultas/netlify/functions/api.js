const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getStore } = require("@netlify/blobs");

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = "pc_session";
const SESSION_DAYS = 180;

function usersStore() {
  return getStore({ name: "users", consistency: "strong" });
}
function dataStore() {
  return getStore({ name: "userdata", consistency: "strong" });
}

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
    body: JSON.stringify(body),
  };
}

function makeCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * SESSION_DAYS}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
function parseCookies(header) {
  const out = {};
  String(header || "")
    .split(";")
    .forEach((pair) => {
      const idx = pair.indexOf("=");
      if (idx === -1) return;
      out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
  return out;
}

async function getEmailFromRequest(event) {
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.email || null;
  } catch {
    return null;
  }
}

function emptyData() {
  return {
    days: {},
    settings: {
      typePrices: { adulto: 15, pediatria: 20, one: 20 },
      monthlyGoals: {},
    },
  };
}

exports.handler = async (event) => {
  if (!JWT_SECRET) {
    return json(500, {
      message: "Configuração ausente: defina a variável de ambiente JWT_SECRET no Netlify.",
    });
  }

  // Extrai o trecho da rota após "/api" (funciona chamado via /api/... ou
  // diretamente via /.netlify/functions/api/...).
  const parts = String(event.path || "").split("/api");
  const path = parts[parts.length - 1] || "/";
  const method = event.httpMethod;

  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return json(400, { message: "Corpo da requisição inválido." });
    }
  }

  try {
    if (path === "/auth/register" && method === "POST") {
      const emailKey = normEmail(body.email);
      const password = String(body.password || "");
      if (!emailKey || !emailKey.includes("@")) return json(400, { message: "E-mail inválido." });
      if (password.length < 8) return json(400, { message: "A senha deve ter ao menos 8 caracteres." });

      const store = usersStore();
      const existing = await store.get(emailKey, { type: "json" });
      if (existing) return json(409, { message: "Já existe uma conta com esse e-mail." });

      const passwordHash = await bcrypt.hash(password, 10);
      await store.setJSON(emailKey, { email: emailKey, passwordHash, createdAt: Date.now() });
      await dataStore().setJSON(emailKey, emptyData());
      return json(200, { message: "Cadastro criado. Faça login." });
    }

    if (path === "/auth/login" && method === "POST") {
      const emailKey = normEmail(body.email);
      const password = String(body.password || "");
      const user = await usersStore().get(emailKey, { type: "json" });
      if (!user) return json(401, { message: "E-mail ou senha inválidos." });
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return json(401, { message: "E-mail ou senha inválidos." });

      const data = (await dataStore().get(emailKey, { type: "json" })) || emptyData();
      const token = jwt.sign({ email: emailKey }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
      return json(200, { user: { email: emailKey }, data }, { "Set-Cookie": makeCookie(token) });
    }

    if (path === "/auth/logout" && method === "POST") {
      return json(200, { message: "ok" }, { "Set-Cookie": clearCookie() });
    }

    if (path === "/auth/session" && method === "GET") {
      const email = await getEmailFromRequest(event);
      if (!email) return json(401, { message: "Sem sessão ativa." });
      const data = (await dataStore().get(email, { type: "json" })) || emptyData();
      return json(200, { user: { email }, data });
    }

    if (path === "/auth/change-password" && method === "POST") {
      const email = await getEmailFromRequest(event);
      if (!email) return json(401, { message: "Sem sessão ativa." });
      const newPassword = String(body.newPassword || "");
      if (newPassword.length < 8) return json(400, { message: "A nova senha deve ter ao menos 8 caracteres." });

      const store = usersStore();
      const user = await store.get(email, { type: "json" });
      if (!user) return json(404, { message: "Usuário não encontrado." });
      const ok = await bcrypt.compare(String(body.currentPassword || ""), user.passwordHash);
      if (!ok) return json(401, { message: "Senha atual incorreta." });

      user.passwordHash = await bcrypt.hash(newPassword, 10);
      await store.setJSON(email, user);
      return json(200, { message: "Senha atualizada." });
    }

    if (path === "/data/save" && method === "POST") {
      const email = await getEmailFromRequest(event);
      if (!email) return json(401, { message: "Sem sessão ativa." });
      if (!body.data || typeof body.data !== "object") return json(400, { message: "Dados inválidos." });
      await dataStore().setJSON(email, body.data);
      return json(200, { message: "ok" });
    }

    return json(404, { message: "Rota não encontrada." });
  } catch (err) {
    console.error(err);
    return json(500, { message: "Erro interno do servidor." });
  }
};

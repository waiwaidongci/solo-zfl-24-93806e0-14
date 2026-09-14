import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./src/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3024);
const dbPath = process.env.DB_PATH || join(__dirname, "data", "app.db");

const { server } = createApp({ dbPath });

server.listen(port, () => {
  console.log(`赛鸽登记站 · 成绩申诉复核系统已启动: http://localhost:${port}`);
  console.log(`数据库文件: ${dbPath}`);
});

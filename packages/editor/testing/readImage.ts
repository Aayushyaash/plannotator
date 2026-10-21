import { handleImage } from "../../server/shared-handlers";

const response = await handleImage(new Request(process.argv[2]));
console.log(JSON.stringify({
  status: response.status,
  body: Buffer.from(await response.arrayBuffer()).toString("base64"),
}));

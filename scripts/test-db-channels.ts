import { createDatabase } from "./server/src/db/client";
import { channels, channelAgents, agents } from "./server/src/db/schema";
const db = createDatabase(process.env.DATABASE_URL);
const allChannels = await db.select().from(channels);
console.log("Channels in DB:", allChannels.map(c => ({ id: c.id, name: c.name, type: c.type })));
const allAgents = await db.select().from(agents);
console.log("Agents in DB:", allAgents.map(a => ({ id: a.id, name: a.name })));

# get-creds

Muestra las credenciales desencriptadas de un bot desde la DB.

## Uso

```
/get-creds <bot-id>
```

## Instrucciones

1. Escribe el script a `scripts/_get-creds-tmp.ts` (dentro del repo para heredar `"type": "module"`), reemplazando `BOT_ID` con el argumento provisto:

```typescript
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.log('Bot BOT_ID not found'); process.exit(1); }
console.log(`Bot BOT_ID:`);
console.log(`  Email: ${decrypt(bot.visaEmail)}`);
console.log(`  Password: ${decrypt(bot.visaPassword)}`);
console.log(`  Schedule: ${bot.scheduleId}`);
console.log(`  Locale: ${bot.locale}`);
console.log(`  Applicants: ${bot.applicantIds}`);
process.exit(0);
```

2. Ejecuta y limpia: `npx tsx --env-file=.env scripts/_get-creds-tmp.ts && rm scripts/_get-creds-tmp.ts`

3. Muestra el resultado al usuario.

> Nota: el script DEBE estar dentro del repo (no en `/tmp/`) para que `tsx` detecte `"type": "module"` del `package.json` y soporte top-level await.

import "server-only"
import { createTranslator } from "next-intl"
import { getLocale } from "next-intl/server"
import en from "./messages/en.json"
import ru from "./messages/ru.json"
import uz from "./messages/uz.json"

// ChatPLUS strings live next to the ChatPLUS features instead of in the
// upstream catalogs, so upstream syncs never conflict on them (SIMPLE-MODE-UX-INVENTORY §4.4).
const catalogs: Record<string, typeof en> = { en, ru, uz }

export async function getChatplusTranslations<
  Namespace extends keyof typeof en,
>(namespace: Namespace) {
  const locale = await getLocale()
  return createTranslator({
    locale,
    messages: catalogs[locale] ?? en,
    namespace,
  })
}

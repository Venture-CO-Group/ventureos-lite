import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Until the approval queue lands (F4), the motor opens on its catalogue. */
export default function OutboundPage() {
  redirect("/outbound/products");
}

import { AppShell } from "@/components/app-shell";
import { OutboundTabs } from "@/components/outbound-tabs";
import { OutboundProducts } from "@/components/outbound-products";
import { listProducts, listSegments, catalogPermissions } from "@/modules/outbound/catalog-actions";

export const dynamic = "force-dynamic";

export default async function OutboundProductsPage() {
  const [products, segments, perms] = await Promise.all([listProducts(), listSegments(), catalogPermissions()]);
  return (
    <AppShell activePath="/outbound">
      <OutboundTabs active="/outbound/products" />
      <OutboundProducts products={products} segments={segments} canEdit={perms.canEditProducts} />
    </AppShell>
  );
}

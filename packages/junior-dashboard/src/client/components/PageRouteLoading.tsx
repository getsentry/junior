import {
  PageContentSkeleton,
  type PageContentSkeletonVariant,
} from "./PageContentSkeleton";
import { PageHeader } from "./layout/PageHeader";
import { PageLayout } from "./layout/PageLayout";

/** Keep a standard page title and body geometry stable during its first load. */
export function PageRouteLoading(props: {
  description: string;
  label: string;
  title: string;
  variant?: PageContentSkeletonVariant;
}) {
  return (
    <PageLayout>
      <PageHeader description={props.description} title={props.title} />
      <PageContentSkeleton label={props.label} variant={props.variant} />
    </PageLayout>
  );
}

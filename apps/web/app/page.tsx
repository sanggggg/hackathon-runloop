import { redirect } from "next/navigation";
import { suite } from "@/lib/fixtures";

export default function Home() {
  redirect(`/suites/${suite.id}/build`);
}

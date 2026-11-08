import type { RoomBroker } from "@/lib/room/context";
import AuthBrandPanel from "@/components/room/AuthBrandPanel";
import RoomForgotForm from "./RoomForgotForm";

// Trader's Room forgot password: the sign-in's brand panel + the reset request. Served at /portal/forgot-password for
// a broker with the CRM module (the sign-in's "Forgot password?" link).
export default async function RoomForgotView({ broker }: { broker: RoomBroker }) {
  return (
    <div className="r-auth">
      <AuthBrandPanel broker={broker} />
      <section className="r-auth-form">
        <RoomForgotForm />
      </section>
    </div>
  );
}

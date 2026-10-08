import { useState } from "react";
import { Button } from "./components/ui/button.jsx";

const PLANS = [
  { id: "starter", name: "Starter", price: 12, note: "For one small team" },
  { id: "growth", name: "Growth", price: 29, note: "Most picked" },
  { id: "scale", name: "Scale", price: 59, note: "For several teams" },
];

export function App() {
  const [picked, setPicked] = useState("growth");
  return (
    <main className="page">
      <header className="page-head">
        <h1>Pick a plan</h1>
        <p className="lead">An example page for trying the designer. Every name and price is invented.</p>
        <div className="actions">
          <Button variant="ghost">Compare plans</Button>
          <Button>Start free trial</Button>
        </div>
      </header>
      <section className="plans">
        {PLANS.map((plan) => (
          <article key={plan.id} className={plan.id === picked ? "plan plan-picked" : "plan"}>
            <h2>{plan.name}</h2>
            <p className="price">
              <span className="amount">${plan.price}</span> per month
            </p>
            <p className="note">{plan.note}</p>
            <Button variant={plan.id === picked ? "solid" : "ghost"} onClick={() => setPicked(plan.id)}>
              {plan.id === picked ? "Selected" : "Choose"}
            </Button>
          </article>
        ))}
      </section>
      <footer className="page-foot">
        <input type="email" placeholder="Your email" aria-label="Email" />
        <Button>Send me the details</Button>
      </footer>
    </main>
  );
}

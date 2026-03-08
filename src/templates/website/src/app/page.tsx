export default function Home() {
  return (
    <div className="mx-auto max-w-5xl px-6">
      {/* Hero */}
      <section className="py-24 text-center">
        <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">
          Welcome to{" "}
          <span className="text-[var(--accent)]">{{name}}</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--muted)]">
          {{description}}
        </p>
        <div className="mt-10 flex justify-center gap-4">
          <a
            href="#cta"
            className="rounded-full bg-[var(--accent)] px-8 py-3 text-white font-semibold hover:opacity-90 transition-opacity"
          >
            Get Started
          </a>
          <a
            href="#features"
            className="rounded-full border border-[var(--border)] px-8 py-3 font-semibold hover:bg-[var(--card)] transition-colors"
          >
            Learn More
          </a>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20">
        <h2 className="text-3xl font-bold text-center mb-12">Features</h2>
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { title: "Fast", desc: "Built for speed with modern tooling and optimized delivery." },
            { title: "Secure", desc: "Security-first architecture with best practices baked in." },
            { title: "Scalable", desc: "Grows with your needs from prototype to production." },
          ].map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 hover:shadow-lg transition-shadow"
            >
              <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
              <p className="text-sm text-[var(--muted)]">{feature.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* About */}
      <section id="about" className="py-20 text-center">
        <h2 className="text-3xl font-bold mb-6">About</h2>
        <p className="mx-auto max-w-2xl text-[var(--muted)]">
          {{name}} is built with Next.js and Tailwind CSS. Edit the pages under{" "}
          <code className="rounded bg-[var(--card)] px-2 py-0.5 text-sm font-mono">
            src/app/
          </code>{" "}
          to customize this site.
        </p>
      </section>

      {/* CTA */}
      <section id="cta" className="py-20 text-center">
        <div className="rounded-3xl bg-[var(--accent)] p-12 text-white">
          <h2 className="text-3xl font-bold mb-4">Ready to get started?</h2>
          <p className="mb-8 opacity-90">
            Start building something amazing today.
          </p>
          <a
            href="#"
            className="rounded-full bg-white px-8 py-3 font-semibold text-[var(--accent)] hover:opacity-90 transition-opacity"
          >
            Start Now
          </a>
        </div>
      </section>
    </div>
  );
}

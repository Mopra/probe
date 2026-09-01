import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { globalConfig } from '../lib/probe';

export const metadata: Metadata = {
  title: 'Data notice',
  description: 'What data probe holds about you, why, and how to have it removed.',
  robots: { index: false, follow: false },
};

/**
 * §9.2.4 and §9.3: the GDPR Article 14 notice linked from every email.
 * Plain language, no tracking, no forms, no login. Nothing on this page reads
 * the database, so it cannot be taken down by a database problem.
 */
export default function DataNoticePage() {
  const postalAddress = globalConfig()?.postal_address ?? null;

  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-8 py-4">
      <header className="flex flex-col gap-2 border-b border-edge pb-6">
        <span className="lbl">Article 14 notice</span>
        <h1 className="text-3xl font-light tracking-tight">Your data</h1>
        <p className="text-sm leading-relaxed text-dim">
          You are reading this because you received one email from us and want to know where your
          address came from. This page is the whole answer. It is short on purpose.
        </p>
      </header>

      <Section title="Who is behind this">
        <p>
          Pradsgaard Labs, a Danish company run by Morten Pradsgaard, is the data controller. We
          build exit1.dev and day3.app.
        </p>
        {postalAddress && (
          <p className="font-mono text-[13px] text-dim">{postalAddress}</p>
        )}
        <p>
          The fastest way to reach a human is to reply to the email you received. It goes to a real
          inbox that Morten reads.
        </p>
      </Section>

      <Section title="What we hold">
        <ul>
          <li>Your email address, or a one way hash of it if you have already opted out.</li>
          <li>
            Where we found the address, such as the contact page of your site or your public
            profile on the site you launched on, and the date we found it.
          </li>
          <li>
            Public information about the product you launched: its name, its url, the description
            you published, and the report our own tool produced about its public surface.
          </li>
          <li>
            Whether the email was delivered, whether you clicked through to the report, and
            whether you replied.
          </li>
        </ul>
        <p>
          We do not hold anything you did not publish yourself, and we never bought your address
          from a list broker.
        </p>
      </Section>

      <Section title="Where it came from">
        <p>
          You launched a product on a public launch directory. Our tool sweeps those directories,
          points our own testing suite at the product, and only writes to you if it found something
          specific and verifiable about your site that morning. If it found nothing, you never heard
          from us. The email itself names the exact page your address was found on.
        </p>
      </Section>

      <Section title="Why we are allowed to hold it">
        <p>
          Legitimate interest, under Article 6(1)(f) of the GDPR. Recital 47 recognises direct
          marketing as a legitimate interest. We balanced that against your privacy by keeping the
          contact to one email, ever, by making the content useful whether or not you care who sent
          it, and by asking you for nothing.
        </p>
      </Section>

      <Section title="Your right to object is absolute">
        <p>
          For direct marketing, you do not have to give a reason and we do not get to weigh it up.
          If you object, we stop. There is no appeal on our side.
        </p>
        <p>Two ways to do it, both equally final:</p>
        <ul>
          <li>Click the unsubscribe link at the bottom of the email. One click, no confirmation page.</li>
          <li>Reply to the email with anything at all. A reply is treated as an objection.</li>
        </ul>
      </Section>

      <Section title="What objecting does">
        <ul>
          <li>It is permanent. There is no way to resubscribe, and we do not offer one.</li>
          <li>
            It is global. It covers every product we run, not only the one that wrote to you. Two
            products, one company, one inbox: honouring an opt out on one and not the other would be
            ignoring it.
          </li>
          <li>
            Your address is deleted at that moment. We keep only a one way hash of it, which is what
            lets us recognise it and stay away from it without holding the address itself.
          </li>
        </ul>
      </Section>

      <Section title="Access, correction and deletion">
        <p>
          Reply to the email and say what you want. We can tell you exactly what we hold about you,
          including the page your address was found on, and we can delete all of it across every
          table. If we delete everything including the hash, we lose the ability to recognise your
          address, so unless you ask otherwise we keep the hash and nothing else.
        </p>
        <p>
          You can also complain to the Danish Data Protection Agency, Datatilsynet, at datatilsynet.dk.
        </p>
      </Section>

      <Section title="No tracking here">
        <p>
          This page sets no cookies, runs no analytics and has no form. The email contains no
          tracking pixel. The only thing we count is whether you clicked through to the report,
          because that tells us whether the report was worth writing.
        </p>
      </Section>

      <footer className="border-t border-edge pt-6 text-xs leading-relaxed text-faint">
        One email per person, ever. No follow ups, no sequence, no list you were added to.
      </footer>
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="lbl">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-dim [&_li]:mb-1.5 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

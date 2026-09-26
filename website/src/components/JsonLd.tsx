/** Renders Schema.org JSON-LD blocks into the document at build time. */
export function JsonLd({ data }: { data: object | object[] }) {
  const blocks = Array.isArray(data) ? data : [data];
  return (
    <>
      {blocks.map((block) => {
        // The payload is build-time site data; escaping `<` keeps it inside the script element.
        const json = JSON.stringify(block).replace(/</g, "\\u003c");
        return (
          <script
            key={json}
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: json }}
          />
        );
      })}
    </>
  );
}

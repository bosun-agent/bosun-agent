import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Agent 답은 마크다운(표, 굵은 글씨, 코드)으로 온다. 원본 HTML은 그리지 않는다(react-markdown 기본값, 계약 7.1).
// 이미지는 그리지 않는다. 도구 결과에 섞인 외부 문자열이 이미지 주소로 들어오면
// 브라우저가 그 주소로 바로 요청을 보내서 대화 내용이 밖으로 샐 수 있다.
const components: Components = {
  img: ({ alt }) => <span className="text-neutral-500">[이미지{alt ? `: ${alt}` : ''}]</span>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-700 underline">
      {children}
    </a>
  ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-neutral-300 pl-3 text-neutral-600">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-neutral-300" />,
  code: ({ children }) => (
    <code className="rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[13px]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-neutral-800 p-3 text-[13px] text-neutral-100 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-neutral-300 bg-neutral-200/60 px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-neutral-300 px-2 py-1 align-top">{children}</td>,
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

import { destr } from 'destr'
import { z } from 'zod'

defineRouteMeta({
  openAPI: {
    description: 'Generate OpenGraph title and description using AI based on the URL',
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: 'url',
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'uri' },
        description: 'The URL to generate OpenGraph metadata for',
      },
    ],
  },
})

interface AiChatResponse {
  response?: string
  choices?: { message?: { content?: string } }[]
}

export default eventHandler(async (event) => {
  const url = (await getValidatedQuery(event, z.object({
    url: z.string().url(),
  }).parse)).url
  const { cloudflare } = event.context
  const { AI } = cloudflare.env

  if (!AI) {
    throw createError({ status: 501, statusText: 'AI not enabled' })
  }

  const { aiOgPrompt, aiModel } = useRuntimeConfig(event)

  const markdown = await fetchPageMarkdown(event, url, AI)
  const userContent = markdown
    ? `URL: ${url}\n\nPage content:\n${markdown}`
    : url

  const messages = [
    { role: 'system', content: aiOgPrompt },

    { role: 'user', content: 'https://www.cloudflare.com/' },
    { role: 'assistant', content: '{"title": "Cloudflare", "description": "Cloudflare is a global network designed to make everything you connect to the Internet secure, private, fast, and reliable."}' },

    { role: 'user', content: 'https://github.com/nuxt/' },
    { role: 'assistant', content: '{"title": "Nuxt", "description": "Nuxt is an intuitive and extensible Vue framework for creating modern web applications."}' },

    { role: 'user', content: userContent },
  ]

  const response = await AI.run(aiModel as keyof AiModels, {
    messages,
    chat_template_kwargs: {
      enable_thinking: false,
    },
  }) as AiChatResponse

  let content = response.response ?? response.choices?.[0]?.message?.content ?? ''

  // 1. Try to strip markdown code block wrapper (e.g. ```json\n{...}\n```)
  const codeBlockMatch = content.match(/```(?:json)?\n([\s\S]*?)```/)
  if (codeBlockMatch?.[1]) {
    content = codeBlockMatch[1].trim()
  }
  else {
    // 2. Try balanced brace extraction to handle trailing conversational text
    const firstBrace = content.indexOf('{')
    if (firstBrace !== -1) {
      let depth = 0
      for (let i = firstBrace; i < content.length; i++) {
        if (content[i] === '{') {
          depth++
        }
        else if (content[i] === '}') {
          depth--
          if (depth === 0) {
            content = content.substring(firstBrace, i + 1)
            break
          }
        }
      }
    }
  }

  let parsed = destr(content)

  // Ensure we always return an object with title and description properties
  if (typeof parsed === 'string') {
    // Attempt to extract title and description as best effort
    // E.g. "Title: My Title\nDescription: My description"
    const titleMatch = parsed.match(/title:\s*([^\n]+)/i) || parsed.match(/"title"\s*:\s*"((?:[^"\\]|\\.)+)"/)
    const descMatch = parsed.match(/description:\s*([^\n]+)/i) || parsed.match(/"description"\s*:\s*"((?:[^"\\]|\\.)+)"/)
    if (titleMatch && descMatch) {
      parsed = { title: titleMatch[1].trim(), description: descMatch[1].trim() }
    }
    else {
      throw createError({
        statusCode: 500,
        statusMessage: 'Invalid AI response format',
      })
    }
  }
  else if (!parsed || typeof parsed !== 'object' || !('title' in parsed) || !('description' in parsed)) {
    throw createError({
      statusCode: 500,
      statusMessage: 'AI response missing title or description property',
    })
  }

  return parsed
})

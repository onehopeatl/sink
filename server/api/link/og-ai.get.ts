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

  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    content = jsonMatch[0]
  }
  else {
    // Strip markdown code block wrapper (e.g. ```json\n{...}\n```)
    const codeBlockMatch = content.match(/```\w*\n([^`]+)```/)
    if (codeBlockMatch?.[1]) {
      content = codeBlockMatch[1].trim()
    }
  }

  return destr(content)
})

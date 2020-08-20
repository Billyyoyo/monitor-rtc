<template>
    <div class="hello">
        App
        <comp value="aaaa" @on-comp-created="showComp"></comp>
    </div>
</template>

<script>

    module.exports = {
        components: {
            'Comp': httpVueLoader('./comp.vue')
        },
        data: function () {
            return {
                who: 'world'
            }
        },
        mounted() {
            Client.joinRoom()
        },
        methods: {
            showComp() {
                console.log(12312312)
            }
        }
    }
</script>

<style scoped>
    .hello {
        background-color: green;
    }
</style>